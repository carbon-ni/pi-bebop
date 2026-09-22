#!/usr/bin/env python3
"""External, model-call-free launcher for a disposable two-member Crew Intake smoke run.

This script owns process lifecycle, disposable workspaces, evidence, and cleanup.
It never changes Bebop production code or interprets agent text as completion.
Starting a run only opens interactive Pi processes. ``publish`` is the explicit
boundary that may cause an agent model turn.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

MAX_FILE_BYTES = 1_048_576
MAX_CAPTURE_BYTES = 32_768
MAX_WAIT_MS = 3_600_000
MIN_TMUX = (3, 5)
THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:md|txt)$")
SENSITIVE_KEY = re.compile(r"(?:token|secret|password|credential|api.?key)", re.I)
TEXT_SECRET_PATTERNS = (
    re.compile(r"(?i)(\bauthorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+"),
    re.compile(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)(\b(?:api[-_ ]?key|x-api-key|access[-_ ]?token|refresh[-_ ]?token|secret|token)\s*[:=]\s*)[^\s,;\"'`\)\]}]+"),
    re.compile(r"(?i)([?&](?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token)=)[^&#\s]+"),
    re.compile(r"(?i)\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b"),
)


class HarnessError(Exception):
    """Expected configuration or lifecycle failure."""


class CommandAdapter(Protocol):
    def executable(self, name: str) -> str | None: ...

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        timeout: float | None = None,
        check: bool = False,
    ) -> "CommandResult": ...


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class SystemAdapter:
    def executable(self, name: str) -> str | None:
        return shutil.which(name)

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        timeout: float | None = None,
        check: bool = False,
    ) -> CommandResult:
        try:
            completed = subprocess.run(
                list(argv),
                cwd=str(cwd) if cwd else None,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise HarnessError(f"command timed out: {shlex.join(argv)}") from error
        result = CommandResult(completed.returncode, completed.stdout, completed.stderr)
        if check and result.returncode != 0:
            raise HarnessError(result.stderr.strip() or f"command failed: {shlex.join(argv)}")
        return result


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_version(text: str) -> tuple[int, int]:
    match = re.search(r"(?:tmux )?(\d+)\.(\d+)", text)
    if not match:
        raise HarnessError(f"could not parse tmux version: {text.strip() or '<empty>'}")
    return int(match.group(1)), int(match.group(2))


def require_version(actual: tuple[int, int], required: tuple[int, int], label: str) -> None:
    if actual < required:
        raise HarnessError(f"{label} {actual[0]}.{actual[1]} is too old; require {required[0]}.{required[1]}+")


def require_safe_name(value: str, label: str) -> str:
    if not SAFE_NAME.fullmatch(value):
        raise HarnessError(f"unsafe {label}: use letters, numbers, '.', '_' or '-'")
    return value


def require_absolute_file(value: str, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise HarnessError(f"{label} must be an existing absolute file")
    if path.is_symlink():
        raise HarnessError(f"{label} must not be a symlink")
    return path.resolve()


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.draft")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def load_state(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise HarnessError(f"invalid run state: {path}") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise HarnessError(f"unsupported run state: {path}")
    return value


def write_bytes_atomically(destination: Path, content: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    draft = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.draft")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(draft, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if destination.exists() or destination.is_symlink():
            raise HarnessError(f"publication target already exists: {destination.name}")
        os.rename(draft, destination)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        draft.unlink(missing_ok=True)
        raise


def redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): ("<redacted>" if SENSITIVE_KEY.search(str(key)) else redact(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return [redact(item) for item in value]
    return value


def redact_text(value: str) -> str:
    """Redact high-confidence credential forms while preserving transcript prose."""
    redacted = value
    for pattern in TEXT_SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1) if match.lastindex else ''}<redacted>", redacted)
    return redacted


def list_children(directory: Path) -> list[str]:
    try:
        return sorted(entry.name for entry in directory.iterdir())
    except FileNotFoundError:
        return []


def tmux_command(adapter: CommandAdapter, tmux: str, args: Sequence[str], *, check: bool = False) -> CommandResult:
    return adapter.run([tmux, *args], timeout=10, check=check)


def pane_rows(adapter: CommandAdapter, tmux: str, session: str) -> list[dict[str, Any]]:
    result = tmux_command(
        adapter,
        tmux,
        ["list-panes", "-t", session, "-F", "#{pane_id}\t#{pane_title}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}"],
    )
    if result.returncode != 0:
        return []
    rows: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) != 5:
            continue
        rows.append({"paneId": fields[0], "title": fields[1], "pid": fields[2], "dead": fields[3] == "1", "command": fields[4]})
    return rows


def tmux_has_session(adapter: CommandAdapter, tmux: str, session: str) -> bool:
    return tmux_command(adapter, tmux, ["has-session", "-t", session]).returncode == 0


def validate_start_options(args: argparse.Namespace, adapter: CommandAdapter) -> tuple[str, str]:
    pi = adapter.executable(args.pi)
    if not pi:
        raise HarnessError(f"pi executable not found: {args.pi}")
    tmux = adapter.executable(args.tmux)
    if not tmux:
        raise HarnessError(f"tmux executable not found: {args.tmux}")
    version = parse_version(tmux_command(adapter, tmux, ["-V"], check=True).stdout)
    require_version(version, MIN_TMUX, "tmux")
    extension = require_absolute_file(args.extension, "extension")
    cli = require_absolute_file(args.cli, "CLI")
    if args.thinking not in THINKING_LEVELS:
        raise HarnessError(f"invalid thinking level: {args.thinking}")
    if not args.provider or not re.fullmatch(r"[A-Za-z0-9._-]+", args.provider):
        raise HarnessError("provider must be a simple provider name")
    if not args.model or any(char.isspace() for char in args.model) or "\x00" in args.model:
        raise HarnessError("model must be a non-empty model identifier without whitespace")
    if args.timeout_ms < 1 or args.timeout_ms > MAX_WAIT_MS:
        raise HarnessError(f"timeout must be between 1 and {MAX_WAIT_MS} ms")
    if args.session_name:
        require_safe_name(args.session_name, "session name")
        if tmux_has_session(adapter, tmux, args.session_name):
            raise HarnessError(f"tmux session already exists: {args.session_name}")
    return pi, tmux


def role_command(
    *,
    pi: str,
    extension: Path,
    project: Path,
    session_dir: Path,
    provider: str,
    model: str,
    thinking: str,
    role: str,
) -> list[str]:
    # No prompt, -p, startup message, or continuation flag is included.
    return [
        pi,
        "--no-extensions",
        "--extension",
        str(extension),
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--offline",
        "--approve",
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        thinking,
        "--session-dir",
        str(session_dir),
        "--name",
        role,
        "--crew",
        "--crew-role",
        role,
    ]


def record_start_failure(run_dir: Path, session: str, adapter: CommandAdapter, tmux: str, error: BaseException, members: Sequence[str]) -> None:
    cleanup = "not-started"
    try:
        if tmux_has_session(adapter, tmux, session):
            tmux_command(adapter, tmux, ["kill-session", "-t", session])
            cleanup = "tmux-session-terminated"
        else:
            cleanup = "no-tmux-session"
        atomic_json(
            run_dir / "failure.json",
            {
                "schemaVersion": 1,
                "status": "startup-failure",
                "failedAt": utc_now(),
                "runDirectory": str(run_dir),
                "tmuxSession": session,
                "cleanup": cleanup,
                "membersStarted": list(members),
                "errorType": type(error).__name__,
                "evidenceBounded": True,
            },
        )
    except BaseException:
        # A partial run without bounded evidence must not remain discoverable.
        shutil.rmtree(run_dir, ignore_errors=True)


def control_command(run_dir: Path) -> str:
    message = f"Crew Intake control surface\nRun: {run_dir}\nUse: status/capture/stop from another shell.\n"
    return "bash -lc " + shlex.quote(f"printf %s {shlex.quote(message)}; exec bash --noprofile --norc")


def validate_manifest_paths(manifest: Mapping[str, Any], manifest_path: Path) -> None:
    """Mirror production's namespace checks for manifest-relative paths."""
    root = manifest_path.parent
    instructions_root = (root / "instructions").resolve()
    sockets_root = (root / "sockets").resolve()

    def require_under(value: Any, namespace: Path, field: str) -> None:
        if not isinstance(value, str) or not value or Path(value).is_absolute():
            raise HarnessError(f"{field} must be a non-empty relative path")
        resolved = (root / value).resolve()
        try:
            resolved.relative_to(namespace)
        except ValueError as error:
            raise HarnessError(f"{field} must remain under {namespace.name}") from error

    require_under(manifest.get("commonInstructionsFile"), instructions_root, "commonInstructionsFile")
    members = manifest.get("members")
    if not isinstance(members, list) or not members:
        raise HarnessError("members must be a non-empty array")
    names: set[str] = set()
    sockets: set[str] = set()
    for member in members:
        if not isinstance(member, Mapping):
            raise HarnessError("member must be an object")
        name = member.get("name")
        if not isinstance(name, str) or not name or name in names:
            raise HarnessError("member names must be non-empty and unique")
        names.add(name)
        socket = member.get("socket")
        require_under(socket, sockets_root, "member socket")
        if socket in sockets:
            raise HarnessError("member socket paths must be unique")
        sockets.add(socket)
        require_under(member.get("instructionsFile"), instructions_root, "member instructionsFile")


INTAKE_GUIDE = """# Crew Intake dropbox

This directory is an external transport boundary, not the crew Inbox. Put a file here only when an outside agent needs to submit context for the configured Intake contact.

## Publish one file

- Write only a non-empty UTF-8 `.md` or `.txt` file no larger than 997,952 UTF-8 bytes, with a filename no longer than 160 UTF-8 bytes, as a direct child of `.pi/bebop/intake/new/`.
- Keep this guide and the source file outside `.pi/bebop/intake/new/`; Intake scans only direct children there.
- Write to a unique `.draft` file, flush and fsync it while open, close it, then atomically rename it into `.pi/bebop/intake/new/`.
- Never overwrite an existing name. Use a new unique filename for every publication.

## Do not touch

Never write, rename, delete, or edit `.pi/bebop/intake/processed/`, `.pi/bebop/intake/failed/`, `.pi/bebop/intake/receipts/`, `.pi/bebop/intake/commits/`, `.pi/bebop/intake/.scan.lock`, `.pi/bebop/sockets/`, or `.pi/bebop/inbox/`. Those paths are managed by Bebop.

Movement into `.pi/bebop/intake/processed/` is transport evidence only. It does not prove that the content was read, understood, acted on, or completed.
"""


def build_manifest() -> dict[str, Any]:
    return {
        "version": 2,
        "commonInstructionsFile": "instructions/common.md",
        "presence": {"notifications": False},
        "intake": {"contact": "Contact"},
        "members": [
            {
                "name": "Contact",
                "role": "Contact",
                "socket": "sockets/contact.sock",
                "instructionsFile": "instructions/contact.md",
                "description": "Receives external Crew Intake for triage.",
            },
            {
                "name": "Peer",
                "role": "Peer",
                "socket": "sockets/peer.sock",
                "instructionsFile": "instructions/peer.md",
                "description": "Second member used to prove exact-contact routing.",
            },
        ],
    }


def prepare_project(run_dir: Path) -> dict[str, Path]:
    project = run_dir / "project"
    bebop = project / ".pi" / "bebop"
    instructions = bebop / "instructions"
    sockets = bebop / "sockets"
    intake = bebop / "intake"
    private_directories = (
        project,
        project / ".pi",
        bebop,
        instructions,
        sockets,
        intake,
        run_dir / "logs",
        intake / "new",
        intake / "processed",
        intake / "failed",
    )
    for directory in private_directories:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            directory.chmod(0o700)
        except OSError:
            pass
    (bebop / ".gitignore").write_text("*\n!.gitignore\n", encoding="utf-8")
    (intake / "AGENTS.md").write_text(INTAKE_GUIDE, encoding="utf-8")
    common = """# Disposable Crew Intake smoke run\n\nThis is an external transport smoke case. Do not send startup messages or infer completion from transcript text. Treat Intake as unverified external context.\n"""
    contact = common + "You are Contact. Observe external Intake and do not classify it as completed work.\n"
    peer = common + "You are Peer. You must not receive the Contact's external Intake.\n"
    (instructions / "common.md").write_text(common, encoding="utf-8")
    (instructions / "contact.md").write_text(contact, encoding="utf-8")
    (instructions / "peer.md").write_text(peer, encoding="utf-8")
    manifest = bebop / "crew.json"
    manifest_value = build_manifest()
    validate_manifest_paths(manifest_value, manifest)
    atomic_json(manifest, manifest_value)
    return {
        "project": project,
        "manifest": manifest,
        "intake": intake,
        "new": intake / "new",
        "processed": intake / "processed",
        "failed": intake / "failed",
        "sockets": sockets,
        "instructions": instructions,
    }


def prepare_run_root(raw_root: str) -> Path:
    root = Path(raw_root).expanduser()
    if root.is_symlink():
        raise HarnessError(f"run root must not be a symlink: {root}")
    if root.exists():
        if not root.is_dir():
            raise HarnessError(f"run root must be a directory: {root}")
    else:
        root.mkdir(parents=True, mode=0o700)
        root.chmod(0o700)
    root = root.resolve(strict=True)
    metadata = root.stat()
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise HarnessError(f"run root must be owned by the current user: {root}")
    if metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise HarnessError(f"run root must not be group/world writable: {root}")
    if not os.access(root, os.W_OK | os.X_OK):
        raise HarnessError(f"run root must be writable: {root}")
    return root


def create_run(args: argparse.Namespace, adapter: CommandAdapter) -> dict[str, Any]:
    pi, tmux = validate_start_options(args, adapter)
    run_dir = Path(args.run_dir).expanduser().resolve() if args.run_dir else None
    if run_dir:
        if run_dir.exists():
            raise HarnessError(f"run directory must be fresh: {run_dir}")
        run_dir.mkdir(parents=True, mode=0o700)
    else:
        root = prepare_run_root(args.run_root)
        run_dir = Path(tempfile.mkdtemp(prefix="intake-", dir=root))
        run_dir.chmod(0o700)
    session = args.session_name or f"bebop-intake-{uuid.uuid4().hex[:12]}"
    if tmux_has_session(adapter, tmux, session):
        shutil.rmtree(run_dir, ignore_errors=True)
        raise HarnessError(f"tmux session already exists: {session}")
    try:
        paths = prepare_project(run_dir)
    except BaseException:
        shutil.rmtree(run_dir, ignore_errors=True)
        raise
    extension = Path(args.extension).expanduser().resolve()
    session_dirs = {role: run_dir / "sessions" / role.lower() for role in ("Contact", "Peer")}
    for directory in session_dirs.values():
        directory.mkdir(parents=True, mode=0o700)
    run_state: dict[str, Any] = {
        "schemaVersion": 1,
        "createdAt": utc_now(),
        "runDirectory": str(run_dir),
        "case": args.case,
        "tmuxSession": session,
        "project": str(paths["project"]),
        "manifest": str(paths["manifest"]),
        "intake": str(paths["intake"]),
        "provider": args.provider,
        "model": args.model,
        "thinking": args.thinking,
        "extension": str(extension),
        "cli": str(Path(args.cli).expanduser().resolve()),
        "timeoutMs": args.timeout_ms,
        "repetitions": 1,
        "concurrency": 1,
        "members": {},
        "modelCallPolicy": "start launches Pi without a prompt; publish is the explicit delivery boundary",
    }
    try:
        order = ["Contact", "Peer"] if args.case == "online" else ["Peer"]
        panes: dict[str, str] = {}
        for index, role in enumerate(order):
            command = role_command(
                pi=pi,
                extension=extension,
                project=paths["project"],
                session_dir=session_dirs[role],
                provider=args.provider,
                model=args.model,
                thinking=args.thinking,
                role=role,
            )
            rendered = "exec " + shlex.join(command)
            if index == 0:
                result = tmux_command(
                    adapter,
                    tmux,
                    ["new-session", "-d", "-s", session, "-n", "crew", "-c", str(paths["project"]), "-P", "-F", "#{pane_id}", rendered],
                    check=True,
                )
            else:
                result = tmux_command(
                    adapter,
                    tmux,
                    ["split-window", "-h", "-t", panes[order[0]], "-c", str(paths["project"]), "-P", "-F", "#{pane_id}", rendered],
                    check=True,
                )
            if result.returncode != 0:
                raise HarnessError(f"tmux failed while starting {role}")
            lines = result.stdout.strip().splitlines()
            pane = lines[-1].strip() if lines else ""
            if not pane:
                raise HarnessError(f"tmux did not return a pane id for {role}")
            panes[role] = pane
            tmux_command(adapter, tmux, ["select-pane", "-t", pane, "-T", role], check=True)
            run_state["members"][role] = {
                "role": role,
                "paneId": pane,
                "sessionDir": str(session_dirs[role]),
                "command": command,
                "startedAt": utc_now(),
            }
        control_result = tmux_command(
            adapter,
            tmux,
            ["split-window", "-v", "-t", panes[order[0]], "-c", str(paths["project"]), "-P", "-F", "#{pane_id}", control_command(run_dir)],
            check=True,
        )
        if control_result.returncode != 0:
            raise HarnessError("tmux failed while creating the control pane")
        control_lines = control_result.stdout.strip().splitlines()
        control_pane = control_lines[-1].strip() if control_lines else ""
        if not control_pane:
            raise HarnessError("tmux did not return a control pane id")
        run_state["controlPane"] = control_pane
        tmux_command(adapter, tmux, ["select-pane", "-t", control_pane, "-T", "Control / evidence"], check=True)
        tmux_command(adapter, tmux, ["set-option", "-t", session, "remain-on-exit", "on"], check=True)
        tmux_command(adapter, tmux, ["select-layout", "-t", session, "tiled"], check=True)
        atomic_json(run_dir / "state.json", run_state)
        wait_for_members_ready(run_dir, order, args.timeout_ms, adapter)
        return run_state
    except BaseException as error:
        # The exact session is the only process boundary this harness created.
        record_start_failure(run_dir, session, adapter, tmux, error, list(run_state["members"]))
        raise


def publish(run_dir: Path, source: Path, name: str | None) -> dict[str, Any]:
    state = load_state(run_dir)
    source = require_absolute_file(str(source), "fixture")
    content = source.read_bytes()
    if not content or len(content) > MAX_FILE_BYTES:
        raise HarnessError(f"fixture must contain between 1 and {MAX_FILE_BYTES} bytes")
    filename = name or source.name
    if not SAFE_FILE.fullmatch(filename):
        raise HarnessError("publication name must be a direct-child .md or .txt filename")
    destination = Path(state["intake"]) / "new" / filename
    if destination.exists() or destination.is_symlink():
        raise HarnessError(f"publication target already exists: {filename}")
    write_bytes_atomically(destination, content)
    return {"status": "published", "file": str(destination), "bytes": len(content), "warning": "delivery may trigger a paid model turn"}


def attach_role(run_dir: Path, role: str, adapter: CommandAdapter) -> dict[str, Any]:
    state = load_state(run_dir)
    role = require_safe_name(role, "role")
    if role not in ("Contact", "Peer"):
        raise HarnessError("role must be Contact or Peer")
    tmux = adapter.executable("tmux") or "tmux"
    session = str(state["tmuxSession"])
    if not tmux_has_session(adapter, tmux, session):
        raise HarnessError(f"tmux session is not running: {session}")
    member = state.get("members", {}).get(role)
    if member:
        return {"status": "already-running", "role": role, "paneId": member["paneId"]}
    project = Path(state["project"])
    session_dir = run_dir / "sessions" / role.lower()
    session_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    command = role_command(
        pi=adapter.executable("pi") or "pi",
        extension=Path(state["extension"]),
        project=project,
        session_dir=session_dir,
        provider=str(state["provider"]),
        model=str(state["model"]),
        thinking=str(state["thinking"]),
        role=role,
    )
    peer_pane = next(iter(state["members"].values()))["paneId"]
    result = tmux_command(adapter, tmux, ["split-window", "-h", "-t", peer_pane, "-c", str(project), "-P", "-F", "#{pane_id}", "exec " + shlex.join(command)], check=True)
    if result.returncode != 0:
        raise HarnessError(f"tmux failed while attaching {role}")
    lines = result.stdout.strip().splitlines()
    pane = lines[-1].strip() if lines else ""
    if not pane:
        raise HarnessError(f"tmux did not return a pane id for {role}")
    tmux_command(adapter, tmux, ["select-pane", "-t", pane, "-T", role], check=True)
    state["members"][role] = {"role": role, "paneId": pane, "sessionDir": str(session_dir), "command": command, "startedAt": utc_now()}
    atomic_json(run_dir / "state.json", state)
    wait_for_members_ready(run_dir, [role], int(state["timeoutMs"]), adapter)
    return {"status": "attached", "role": role, "paneId": pane}


def socket_claimed(path: Path, adapter: CommandAdapter) -> bool:
    test_claims = getattr(adapter, "claimed_sockets", None)
    if test_claims is not None:
        return str(path) in test_claims
    return path.exists() and stat.S_ISSOCK(path.stat().st_mode)


def observe(run_dir: Path, adapter: CommandAdapter) -> dict[str, Any]:
    state = load_state(run_dir)
    tmux = adapter.executable("tmux") or "tmux"
    session = str(state["tmuxSession"])
    panes = pane_rows(adapter, tmux, session) if tmux_has_session(adapter, tmux, session) else []
    intake = Path(state["intake"])
    return {
        "status": "running" if panes else "not-running",
        "runDirectory": str(run_dir),
        "tmuxSession": session,
        "panes": panes,
        "members": {role: {"paneId": value.get("paneId"), "socket": str(Path(state["project"]) / ".pi" / "bebop" / "sockets" / f"{role.lower()}.sock"), "socketExists": socket_claimed(Path(state["project"]) / ".pi" / "bebop" / "sockets" / f"{role.lower()}.sock", adapter)} for role, value in state.get("members", {}).items()},
        "intakeFiles": {
            "new": list_children(intake / "new"),
            "processed": list_children(intake / "processed"),
            "failed": list_children(intake / "failed"),
        },
        "evidencePaths": {"state": str(run_dir / "state.json"), "captureDirectory": str(run_dir / "captures")},
        "note": "Presence, pane state, and file state are transport evidence; they do not prove a message was read, acted on, or completed.",
    }


STARTUP_ERROR_MARKERS = ("crew startup role join failed", "startup role join failed", "error: failed to join")


def capture_pane_tail(adapter: CommandAdapter, tmux: str, pane_id: str) -> str:
    result = tmux_command(adapter, tmux, ["capture-pane", "-p", "-t", pane_id, "-S", "-200"])
    return result.stdout if result.returncode == 0 else ""


def wait_for_members_ready(run_dir: Path, roles: Sequence[str], timeout_ms: int, adapter: CommandAdapter) -> dict[str, Any]:
    state = load_state(run_dir)
    tmux = adapter.executable("tmux") or "tmux"
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        observation = observe(run_dir, adapter)
        rows = {row["paneId"]: row for row in observation["panes"]}
        missing: list[str] = []
        for role in roles:
            member = observation["members"].get(role, {})
            pane = rows.get(member.get("paneId"))
            pane_text = capture_pane_tail(adapter, tmux, str(member.get("paneId", ""))).lower()
            if any(marker in pane_text for marker in STARTUP_ERROR_MARKERS):
                raise HarnessError(f"{role} startup reported a role-join error")
            socket_path = Path(str(member.get("socket", "")))
            socket_ready = socket_claimed(socket_path, adapter)
            if not socket_ready or pane is None or pane["dead"]:
                missing.append(role)
        if not missing:
            return observation
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HarnessError(f"startup readiness timeout; missing socket claims or live panes: {', '.join(missing)}")
        time.sleep(min(0.1, remaining))


def wait_for(run_dir: Path, kind: str, timeout_ms: int, adapter: CommandAdapter) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = observe(run_dir, adapter)
        files = value["intakeFiles"]
        if kind == "processed" and files["processed"] and not files["new"]:
            return value
        if kind == "contact-socket" and value["members"].get("Contact", {}).get("socketExists"):
            return value
        if kind == "contact-pane" and any(row["title"] == "Contact" and not row["dead"] for row in value["panes"]):
            return value
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HarnessError(f"bounded wait timed out: {kind}")
        time.sleep(min(0.1, remaining))


def capture(run_dir: Path, adapter: CommandAdapter, max_bytes: int = MAX_CAPTURE_BYTES) -> dict[str, Any]:
    if max_bytes < 1 or max_bytes > MAX_CAPTURE_BYTES:
        raise HarnessError(f"capture bound must be between 1 and {MAX_CAPTURE_BYTES}")
    state = load_state(run_dir)
    tmux = adapter.executable("tmux") or "tmux"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = run_dir / "captures" / timestamp
    directory.mkdir(parents=True, exist_ok=False)
    panes: dict[str, Any] = {}
    for role, member in {**state.get("members", {}), "Control / evidence": {"paneId": state.get("controlPane")}}.items():
        pane = member.get("paneId")
        if not pane:
            continue
        result = tmux_command(adapter, tmux, ["capture-pane", "-p", "-S", "-200", "-t", pane])
        text = redact_text(result.stdout)
        text = text.encode("utf-8")[:max_bytes].decode("utf-8", "replace")
        (directory / (re.sub(r"[^A-Za-z0-9._-]+", "_", role.lower()) + ".txt")).write_text(text, encoding="utf-8")
        panes[role] = {"paneId": pane, "returnCode": result.returncode, "bytes": len(text.encode("utf-8"))}
    snapshot = {"capturedAt": utc_now(), "state": redact(state), "status": redact(observe(run_dir, adapter)), "panes": panes}
    atomic_json(directory / "evidence.json", snapshot)
    (directory / "manifest.json").write_text(Path(state["manifest"]).read_text(encoding="utf-8"), encoding="utf-8")
    return {"status": "captured", "directory": str(directory), "boundedBytes": max_bytes, "panes": panes}


def stop(run_dir: Path, adapter: CommandAdapter, remove: bool = False) -> dict[str, Any]:
    if not run_dir.exists():
        if remove:
            return {"status": "already-removed", "removed": True, "runDirectory": str(run_dir), "sessionWasRunning": False, "stopWasIdempotent": True}
        raise HarnessError(f"run directory does not exist: {run_dir}")
    state = load_state(run_dir)
    tmux = adapter.executable("tmux") or "tmux"
    session = str(state["tmuxSession"])
    existed = tmux_has_session(adapter, tmux, session)
    if existed:
        tmux_command(adapter, tmux, ["kill-session", "-t", session], check=True)
    state["stoppedAt"] = utc_now()
    state["stopWasIdempotent"] = not existed
    if remove:
        shutil.rmtree(run_dir, ignore_errors=False)
        return {"status": "stopped", "removed": True, "runDirectory": str(run_dir), "sessionWasRunning": existed}
    atomic_json(run_dir / "state.json", state)
    return {"status": "stopped", "removed": False, "runDirectory": str(run_dir), "sessionWasRunning": existed, "stopWasIdempotent": not existed}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="prepare an isolated run and open Pi panes without a prompt")
    start.add_argument("--run-dir")
    start.add_argument("--run-root", default=os.path.join(tempfile.gettempdir(), "pi-bebop-crew-intake"))
    start.add_argument("--case", choices=("online", "contact-joins-later"), default="online")
    start.add_argument("--provider", required=True)
    start.add_argument("--model", required=True)
    start.add_argument("--thinking", default="off", choices=sorted(THINKING_LEVELS))
    start.add_argument("--extension", default=str(Path(__file__).resolve().parents[3] / "dist" / "extension.js"))
    start.add_argument("--cli", default=str(Path(__file__).resolve().parents[3] / "dist" / "cli" / "main.js"))
    start.add_argument("--pi", default="pi")
    start.add_argument("--tmux", default="tmux")
    start.add_argument("--session-name")
    start.add_argument("--timeout-ms", type=int, default=120_000)
    for command in ("publish", "status", "capture", "stop", "attach"):
        sub.add_parser(command)
    sub.choices["publish"].add_argument("--run-dir", required=True)
    sub.choices["publish"].add_argument("--file", required=True)
    sub.choices["publish"].add_argument("--name")
    sub.choices["publish"].add_argument("--confirm-paid", action="store_true", help="explicitly acknowledge that delivery may trigger a paid model turn")
    sub.choices["status"].add_argument("--run-dir", required=True)
    sub.choices["status"].add_argument("--wait-for", choices=("processed", "contact-socket", "contact-pane"))
    sub.choices["status"].add_argument("--timeout-ms", type=int, default=120_000)
    sub.choices["capture"].add_argument("--run-dir", required=True)
    sub.choices["capture"].add_argument("--max-bytes", type=int, default=MAX_CAPTURE_BYTES)
    sub.choices["stop"].add_argument("--run-dir", required=True)
    sub.choices["stop"].add_argument("--remove", action="store_true")
    sub.choices["attach"].add_argument("--run-dir", required=True)
    sub.choices["attach"].add_argument("--role", choices=("Contact", "Peer"), default="Contact")
    sub.choices["attach"].add_argument("--view", action="store_true", help="attach this terminal to the tmux session")
    return parser


def main(argv: Sequence[str] | None = None, adapter: CommandAdapter | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    adapter = adapter or SystemAdapter()
    try:
        if args.command == "start":
            state = create_run(args, adapter)
            print(json.dumps({"status": "started", "runDirectory": state["runDirectory"], "tmuxSession": state["tmuxSession"], "case": state["case"], "membersStarted": sorted(state["members"]), "modelCallPolicy": state["modelCallPolicy"]}, sort_keys=True))
        elif args.command == "publish":
            if not args.confirm_paid:
                raise HarnessError("publish requires --confirm-paid because delivery may trigger a paid model turn")
            print(json.dumps(publish(Path(args.run_dir).expanduser().resolve(), Path(args.file), args.name), sort_keys=True))
        elif args.command == "status":
            result = wait_for(Path(args.run_dir).expanduser().resolve(), args.wait_for, args.timeout_ms, adapter) if args.wait_for else observe(Path(args.run_dir).expanduser().resolve(), adapter)
            print(json.dumps(result, sort_keys=True))
        elif args.command == "capture":
            print(json.dumps(capture(Path(args.run_dir).expanduser().resolve(), adapter, args.max_bytes), sort_keys=True))
        elif args.command == "stop":
            print(json.dumps(stop(Path(args.run_dir).expanduser().resolve(), adapter, args.remove), sort_keys=True))
        elif args.command == "attach":
            run_dir = Path(args.run_dir).expanduser().resolve()
            if args.view:
                state = load_state(run_dir)
                tmux = adapter.executable("tmux") or "tmux"
                result = adapter.run([tmux, "attach-session", "-t", str(state["tmuxSession"])])
                if result.returncode != 0:
                    raise HarnessError(result.stderr.strip() or "tmux attach failed")
                print(json.dumps({"status": "attached-view", "tmuxSession": state["tmuxSession"]}, sort_keys=True))
            else:
                print(json.dumps(attach_role(run_dir, args.role, adapter), sort_keys=True))
        return 0
    except (HarnessError, OSError, ValueError) as error:
        print(f"crew-intake-smoke: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
