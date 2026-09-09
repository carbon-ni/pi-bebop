#!/usr/bin/env python3
"""Run isolated Crew evaluation cases and aggregate truthful benchmark artifacts.

The runner has no provider-specific model implementation. A command adapter is
an explicit child-process boundary; tests and offline smoke runs use the fake
transport. All completion is correlated to a request id. Mechanical idle,
notifications, sleeps, and process exit never complete a request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import select
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

SCHEMA_VERSION = "1.0"
MAX_TIMEOUT_MS = 3_600_000
MAX_CONCURRENCY = 128
MAX_OUTPUT_BYTES = 1_048_576


class RunnerError(Exception):
    """Expected user/configuration/validation error."""


class InfrastructureError(RunnerError):
    """Execution failure that must never become a passing assertion."""


class TimeoutFailure(InfrastructureError):
    """Bounded operation timeout."""


class CancelledFailure(InfrastructureError):
    """User cancellation."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(value: str) -> bool:
    path = Path(value)
    return (
        bool(value)
        and not path.is_absolute()
        and ".." not in path.parts
        and "\\" not in value
        and not value.startswith("~")
    )


def ensure_inside(root: Path, child: Path) -> Path:
    root_resolved = root.resolve()
    child_resolved = child.resolve()
    try:
        child_resolved.relative_to(root_resolved)
    except ValueError as error:
        raise RunnerError(f"path escapes workspace: {child}") from error
    return child_resolved


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RunnerError(f"invalid {label}: {path}: {error}") from error
    if not isinstance(value, dict):
        raise RunnerError(f"invalid {label}: expected JSON object: {path}")
    return value


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def append_jsonl(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


def bounded_integer(value: str, label: str, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{label} must be an integer") from error
    if not 1 <= parsed <= maximum:
        raise argparse.ArgumentTypeError(f"{label} must be between 1 and {maximum}")
    return parsed


def absolute_file(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise argparse.ArgumentTypeError("must be an existing absolute file path")
    return path.resolve()


def fresh_directory(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.exists():
        raise argparse.ArgumentTypeError("must be a fresh absolute run directory")
    return path


def absolute_directory(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise argparse.ArgumentTypeError("must be an existing absolute directory")
    return path.resolve()


def parse_model(value: str) -> tuple[str, dict[str, str]]:
    if "=" not in value or "/" not in value.split("=", 1)[1]:
        raise argparse.ArgumentTypeError("model must be MEMBER=PROVIDER/MODEL")
    member, provider_model = value.split("=", 1)
    provider, model = provider_model.split("/", 1)
    if not member or not provider or not model:
        raise argparse.ArgumentTypeError("model must be MEMBER=PROVIDER/MODEL")
    return member, {"provider": provider, "model": model, "thinking": "default"}


def parse_provider_model(value: str) -> dict[str, str]:
    if "/" not in value:
        raise argparse.ArgumentTypeError("grader model must be PROVIDER/MODEL")
    provider, model = value.split("/", 1)
    if not provider or not model:
        raise argparse.ArgumentTypeError("grader model must be PROVIDER/MODEL")
    return {"provider": provider, "model": model, "thinking": "default", "configurationSource": "runner"}


def parse_command(value: str) -> tuple[str, list[str]]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("member command must be MEMBER=COMMAND")
    member, command = value.split("=", 1)
    argv = shlex.split(command)
    if not member or not argv:
        raise argparse.ArgumentTypeError("member command must be MEMBER=COMMAND")
    return member, argv


def validate_manifest(path: Path) -> dict[str, Any]:
    manifest = load_json(path, "template manifest")
    if manifest.get("version") != 2:
        raise RunnerError("template manifest must use version 2")
    members = manifest.get("members")
    if not isinstance(members, list) or not members:
        raise RunnerError("template manifest must declare members")
    names: set[str] = set()
    sockets: set[str] = set()
    template_root = path.parent.resolve()
    common = manifest.get("commonInstructionsFile")
    instruction_files = [common] if common else []
    for member in members:
        if not isinstance(member, dict):
            raise RunnerError("template member must be an object")
        name = member.get("name")
        socket = member.get("socket")
        instructions = member.get("instructionsFile")
        if not isinstance(name, str) or not name or name in names:
            raise RunnerError("template member names must be non-empty and unique")
        if not isinstance(socket, str) or not safe_relative(socket) or socket in sockets:
            raise RunnerError(f"member socket must be unique and relative: {name}")
        if not isinstance(instructions, str) or not safe_relative(instructions):
            raise RunnerError(f"member instructions path must be relative: {name}")
        names.add(name)
        sockets.add(socket)
        instruction_files.append(instructions)
    for relative in instruction_files:
        if not isinstance(relative, str):
            raise RunnerError("commonInstructionsFile is required")
        source = ensure_inside(template_root, template_root / relative)
        if not source.is_file():
            raise RunnerError(f"missing template instruction file: {relative}")
        source.read_text(encoding="utf-8")
    return manifest


def validate_case(path: Path) -> dict[str, Any]:
    case = load_json(path, "evaluation case")
    required = ("schemaVersion", "caseId", "prompt", "expectedDeliverable", "expectations", "allowedEffects", "timeoutMs")
    missing = [field for field in required if field not in case]
    if missing or case.get("schemaVersion") != SCHEMA_VERSION:
        raise RunnerError(f"case must use TASK-0197 schemaVersion 1.0 and fields: {', '.join(missing)}")
    if not isinstance(case["caseId"], str) or not case["caseId"]:
        raise RunnerError("caseId must be non-empty")
    if not isinstance(case["prompt"], str) or not case["prompt"]:
        raise RunnerError("case prompt must be non-empty")
    if not isinstance(case["expectations"], list) or not case["expectations"]:
        raise RunnerError("case must declare expectations before execution")
    if not isinstance(case["expectedDeliverable"], dict):
        raise RunnerError("case expectedDeliverable must be an object")
    timeout = case["timeoutMs"]
    if not isinstance(timeout, int) or not 1 <= timeout <= MAX_TIMEOUT_MS:
        raise RunnerError("case timeoutMs is outside bounds")
    fixture_paths = case.get("fixturePaths", [])
    if not isinstance(fixture_paths, list) or any(not isinstance(item, str) or not safe_relative(item) for item in fixture_paths):
        raise RunnerError("fixturePaths must be safe relative paths")
    effects = case["allowedEffects"]
    if not isinstance(effects, dict) or effects.get("network") not in ("none", "declared_endpoints_only"):
        raise RunnerError("allowedEffects must declare a bounded network policy")
    if any(not isinstance(item, str) or not safe_relative(item) for item in effects.get("files", [])):
        raise RunnerError("allowed effect file paths must be safe relative paths")
    if any(not isinstance(item, str) or not item for item in effects.get("commands", [])):
        raise RunnerError("allowed effect commands must be non-empty strings")
    return case


def validate_configuration(path: Path) -> dict[str, Any]:
    config = load_json(path, "configuration")
    if config.get("schemaVersion") not in (None, SCHEMA_VERSION):
        raise RunnerError("configuration schemaVersion must be 1.0")
    if config.get("kind") not in (None, "with_crew", "single_agent", "prior_template"):
        raise RunnerError("configuration kind is invalid")
    return config


def validate_commands(commands: Mapping[str, Sequence[str]]) -> None:
    for member, command in commands.items():
        if not command:
            raise RunnerError(f"empty command adapter: {member}")
        if shutil.which(command[0]) is None:
            raise RunnerError(f"executable dependency is unavailable: {command[0]}")


def validate_models(models: Mapping[str, Mapping[str, str]], members: Sequence[Mapping[str, Any]]) -> None:
    names = {str(member["name"]) for member in members}
    if set(models) != names:
        missing = sorted(names - set(models))
        extra = sorted(set(models) - names)
        raise RunnerError(f"explicit model settings must cover members; missing={missing}, extra={extra}")


def copy_template(manifest_path: Path, project: Path) -> tuple[Path, dict[str, Any]]:
    manifest = validate_manifest(manifest_path)
    layout = project / ".pi" / "bebop"
    instructions = layout / "instructions"
    sockets = layout / "sockets"
    state = project / ".crew-eval-session-state"
    instructions.mkdir(parents=True)
    sockets.mkdir()
    state.mkdir()
    destination_manifest = layout / "crew.json"
    shutil.copy2(manifest_path, destination_manifest)
    for relative in filter(None, [manifest.get("commonInstructionsFile"), *(m["instructionsFile"] for m in manifest["members"])]):
        source = ensure_inside(manifest_path.parent, manifest_path.parent / relative)
        destination = ensure_inside(layout, layout / relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return destination_manifest, manifest


def template_snapshot(manifest_path: Path) -> dict[str, str]:
    return {"path": manifest_path.name, "sha256": sha256(manifest_path)}


def member_path(name: str) -> str:
    safe = "".join(char if char.isalnum() or char in "._-" else "_" for char in name)
    return safe or "member"


def request_id(run_id: str, member: str, sequence: int) -> str:
    return f"{run_id}-{member_path(member)}-{sequence}"


@dataclass
class Completion:
    request_id: str
    payload: dict[str, Any]
    completed_at: str
    usage: dict[str, Any] | None = None


class FakeChild:
    """A fake configured child with explicit request/response completion."""

    def __init__(self, member: str):
        self.member = member
        self.started = True
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True


class FakeTransport:
    """Deterministic fake child/transport used by tests and offline smoke runs."""

    def __init__(self, responses: Mapping[str, Any] | None = None, failures: Mapping[str, str] | None = None):
        self.responses = dict(responses or {})
        self.failures = dict(failures or {})
        self.started: list[str] = []
        self.children: dict[str, FakeChild] = {}
        self.stopped = False
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def start_members(self, members: Sequence[Mapping[str, Any]], workspace: Path) -> None:
        self.started = [str(member["name"]) for member in members]
        self.children = {name: FakeChild(name) for name in self.started}

    def request(self, member: str, request: str, payload: dict[str, Any], timeout_ms: int) -> Completion:
        self.requests.append((member, request, payload))
        if member in self.failures:
            raise InfrastructureError(self.failures[member])
        response = self.responses.get(member)
        if callable(response):
            response = response(member, payload)
        if response is None:
            response = default_response(member, payload)
        if not isinstance(response, dict):
            raise InfrastructureError(f"fake response for {member} is not an object")
        response = dict(response)
        usage = response.pop("__usage", None)
        if usage is not None and not isinstance(usage, dict):
            raise InfrastructureError(f"fake usage for {member} is not an object")
        return Completion(request, response, now(), usage)

    def stop_all(self, timeout_ms: int) -> None:
        for child in self.children.values():
            child.stop()
        self.stopped = True


class ProcessTransport:
    """Explicit command adapter. A child reads request JSONL and writes completion JSONL."""

    def __init__(self, commands: Mapping[str, Sequence[str]]):
        self.commands = {name: list(command) for name, command in commands.items()}
        self.processes: dict[str, subprocess.Popen[str]] = {}
        self.workspace: Path | None = None

    def start_members(self, members: Sequence[Mapping[str, Any]], workspace: Path) -> None:
        self.workspace = workspace
        missing = [str(member["name"]) for member in members if member["name"] not in self.commands]
        if missing:
            raise InfrastructureError(f"no command adapter for configured members: {missing}")
        for member in members:
            name = str(member["name"])
            self.processes[name] = subprocess.Popen(
                self.commands[name],
                cwd=workspace,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )

    def request(self, member: str, request: str, payload: dict[str, Any], timeout_ms: int) -> Completion:
        process = self.processes.get(member)
        if process is None or process.stdin is None or process.stdout is None:
            raise InfrastructureError(f"member process is not running: {member}")
        process.stdin.write(json.dumps({"requestId": request, "member": member, "payload": payload}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            remaining = max(0, deadline - time.monotonic())
            ready, _, _ = select.select([process.stdout], [], [], remaining)
            if not ready:
                break
            line = process.stdout.readline()
            if not line:
                if process.poll() is not None:
                    raise InfrastructureError(f"member process exited before completion: {member}")
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise InfrastructureError(f"malformed completion from {member}: {error}") from error
            if value.get("requestId") != request:
                raise InfrastructureError(f"completion correlation mismatch from {member}")
            if value.get("status") != "completed":
                raise InfrastructureError(f"member {member} returned non-completed status")
            payload_value = value.get("payload")
            if not isinstance(payload_value, dict):
                raise InfrastructureError(f"member {member} completion payload is not an object")
            usage = value.get("usage")
            if usage is not None and not isinstance(usage, dict):
                raise InfrastructureError(f"member {member} usage is not an object")
            return Completion(request, payload_value, now(), usage)
        raise TimeoutFailure(f"member completion timed out: {member}")

    def stop_all(self, timeout_ms: int) -> None:
        deadline = time.monotonic() + timeout_ms / 1000
        for process in self.processes.values():
            if process.poll() is None:
                process.terminate()
        for process in self.processes.values():
            remaining = max(0.1, deadline - time.monotonic())
            try:
                process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=max(0.1, timeout_ms / 1000))
        if self.workspace is not None:
            for name, process in self.processes.items():
                stderr = process.stderr.read() if process.stderr is not None else ""
                target = self.workspace.parent / "members" / member_path(name) / "stderr.log"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(stderr, encoding="utf-8")
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()


def default_response(member: str, payload: dict[str, Any]) -> dict[str, Any]:
    role = payload.get("role")
    if role == "worker":
        return {"artifact": {"member": member, "prompt": payload.get("prompt", "")}, "evidenceRefs": ["inputs/case.json"], "__usage": {"input": 10, "output": 5, "total": 15}}
    if role == "judge":
        return {
            "schemaVersion": "1.0",
            "checkpointId": payload.get("checkpointId", "artifact-ready"),
            "verdict": "continue",
            "criteria": [{"id": "default", "result": "satisfied", "evidenceRefs": ["inputs/case.json"], "uncertainty": None}],
            "evidenceRefs": ["inputs/case.json"],
            "uncertainty": "",
            "requestedMissingEvidence": [],
            "__usage": {"input": 10, "output": 5, "total": 15},
        }
    if role == "chair":
        return {"finalVerdict": "continue", "evidenceRefs": ["inputs/case.json"], "uncertainty": "", "__usage": {"input": 10, "output": 5, "total": 15}}
    return {"result": "completed", "evidenceRefs": ["inputs/case.json"], "__usage": {"input": 10, "output": 5, "total": 15}}


def build_payload(member: Mapping[str, Any], case: Mapping[str, Any], artifact: Mapping[str, Any] | None, judges: Mapping[str, Any] | None = None) -> dict[str, Any]:
    role = str(member.get("role", ""))
    payload: dict[str, Any] = {
        "role": role,
        "prompt": case["prompt"],
        "caseId": case["caseId"],
        "checkpointId": case.get("checkpointId", "artifact-ready"),
        "rubric": case.get("expectations", []),
        "allowedVerdicts": ["continue", "revise", "gather-evidence", "escalate"],
        "allowedEffects": case.get("allowedEffects", {}),
    }
    if artifact is not None:
        payload["artifact"] = artifact
    if judges is not None:
        payload["independentJudgments"] = judges
    return payload


def record_exchange(side_dir: Path, member: str, request: str, payload: dict[str, Any], completion: Completion, sequence: int) -> None:
    transcript = side_dir / "members" / member_path(member) / "transcript.jsonl"
    append_jsonl(transcript, {"schemaVersion": SCHEMA_VERSION, "eventId": f"{request}-input", "sequence": sequence * 2 - 1, "timestamp": now(), "member": member, "kind": "input", "content": json.dumps(payload, sort_keys=True)})
    append_jsonl(transcript, {"schemaVersion": SCHEMA_VERSION, "eventId": f"{request}-output", "sequence": sequence * 2, "timestamp": completion.completed_at, "member": member, "kind": "final", "content": json.dumps(completion.payload, sort_keys=True)})
    append_jsonl(side_dir / "message-trace.jsonl", {"schemaVersion": SCHEMA_VERSION, "eventId": request, "sequence": sequence, "timestamp": completion.completed_at, "sender": "external-harness", "recipient": member, "deliveryKind": "request", "correlation": request, "outcome": "handed", "messageBytes": len(json.dumps(payload))})


def make_timing(member: str, start: float, end: float, status: str = "completed", usage: Mapping[str, Any] | None = None) -> dict[str, Any]:
    token_usage = {"input": None, "output": None, "total": None, "source": "unknown"}
    if usage and all(isinstance(usage.get(key), int) and usage[key] >= 0 for key in ("input", "output", "total")):
        token_usage = {"input": usage["input"], "output": usage["output"], "total": usage["total"], "source": "provider_report"}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "member": member,
        "startedAt": datetime.fromtimestamp(start, timezone.utc).isoformat().replace("+00:00", "Z"),
        "endedAt": datetime.fromtimestamp(end, timezone.utc).isoformat().replace("+00:00", "Z"),
        "durationMs": max(0, int((end - start) * 1000)),
        "tokenUsage": token_usage,
        "toolCalls": 0,
        "messageCount": 1,
        "status": status,
    }


def copy_fixtures(case: Mapping[str, Any], case_path: Path, destination: Path) -> None:
    fixture_root = case_path.parent
    for relative in case.get("fixturePaths", []):
        source = ensure_inside(fixture_root, fixture_root / relative)
        if not source.is_file():
            raise RunnerError(f"missing fixture: {relative}")
        target = ensure_inside(destination, destination / "fixtures" / relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def preflight_pair(case: Mapping[str, Any], candidate_config: Mapping[str, Any], baseline_config: Mapping[str, Any] | None) -> None:
    if baseline_config is None:
        return
    for field in ("prompt", "fixturePaths", "expectations", "expectedDeliverable", "allowedEffects", "timeoutMs", "permissions"):
        if candidate_config.get(field) is not None and baseline_config.get(field) is not None and candidate_config[field] != baseline_config[field]:
            raise RunnerError(f"candidate and baseline configuration differ for {field}")
    if candidate_config.get("caseId") and baseline_config.get("caseId") and candidate_config["caseId"] != baseline_config["caseId"]:
        raise RunnerError("candidate and baseline caseId differ")
    candidate_template = candidate_config.get("templatePath")
    baseline_template = baseline_config.get("templatePath")
    if candidate_template and baseline_template and Path(candidate_template).resolve() != Path(baseline_template).resolve():
        raise RunnerError("candidate and baseline template snapshots differ")
    candidate_output = candidate_config.get("outputDirectory")
    baseline_output = baseline_config.get("outputDirectory")
    if candidate_output and baseline_output and Path(candidate_output).resolve() == Path(baseline_output).resolve():
        raise RunnerError("candidate and baseline cannot reuse an output directory")
    candidate_artifact = candidate_config.get("artifactPath")
    baseline_artifact = baseline_config.get("artifactPath")
    if candidate_artifact and baseline_artifact and Path(candidate_artifact).resolve() == Path(baseline_artifact).resolve():
        raise RunnerError("baseline cannot reuse a candidate-produced artifact; provide immutable case input")


def grade_run(case: Mapping[str, Any], side_dir: Path, infrastructure: InfrastructureError | None, grader: Mapping[str, str] | None = None) -> dict[str, Any]:
    assertions: list[dict[str, Any]] = []
    deliverable = side_dir / "outputs" / "deliverable.json"
    deliverable_status = "present" if deliverable.is_file() else "missing"
    evidence = [{"kind": "output", "path": "outputs/deliverable.json", "selector": "$", "sha256": sha256(deliverable)}] if deliverable.is_file() else []
    if not evidence:
        fallback = next(iter(sorted((side_dir / "members").glob("*/transcript.jsonl"))), None)
        if fallback is not None:
            evidence = [{"kind": "transcript", "path": str(fallback.relative_to(side_dir)), "selector": "$", "sha256": sha256(fallback)}]
    for expectation in case["expectations"]:
        expectation_id = expectation.get("id", f"expectation-{len(assertions) + 1}")
        authority = expectation.get("authority", "deterministic")
        kind = expectation.get("kind", "required_file")
        status = "passed"
        reason = "deterministic artifact exists"
        if infrastructure:
            status = "not_run"
            reason = "infrastructure error prevented grading"
        elif authority == "semantic":
            status = "not_run"
            reason = "independent semantic grader was not selected"
        elif kind == "required_file" and not deliverable.is_file():
            status = "failed"
            reason = "declared deliverable is missing"
        assertions.append({"id": expectation_id, "authority": authority, "status": status, "evidence": evidence or [{"kind": "output", "path": "outputs/deliverable.json", "selector": "$"}], "reason": reason})
    terminal = "invalid_infrastructure" if infrastructure else ("passed" if all(item["status"] == "passed" for item in assertions) else "failed")
    grading: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "evalId": case.get("evalId", "crew-eval"),
        "caseId": case["caseId"],
        "runId": side_dir.name,
        "deliverable": {"id": case["expectedDeliverable"].get("id", "deliverable"), "status": deliverable_status, **({"path": "outputs/deliverable.json", "sha256": sha256(deliverable)} if deliverable.is_file() else {})},
        "assertions": assertions,
        "infrastructure": {"status": "error", "code": "RUN_FAILURE", "summary": str(infrastructure), "evidence": []} if infrastructure else {"status": "none"},
        **({"semanticGrader": dict(grader)} if grader else {}),
        "terminalResult": terminal,
    }
    write_json(side_dir / "grading.json", grading)
    return grading


def run_side(template_path: Path, case_path: Path, case: Mapping[str, Any], configuration: Mapping[str, Any], side_dir: Path, models: Mapping[str, Mapping[str, str]], timeout_ms: int, concurrency: int, transport_factory: Callable[[], Any], artifact_path: Path | None = None, grader: Mapping[str, str] | None = None) -> dict[str, Any]:
    side_dir.mkdir(parents=True)
    project = side_dir / "project"
    inputs = side_dir / "inputs"
    outputs = side_dir / "outputs"
    project.mkdir()
    inputs.mkdir()
    outputs.mkdir()
    copy_fixtures(case, case_path, inputs)
    copied_manifest, manifest = copy_template(template_path, project)
    members = manifest["members"]
    validate_models(models, members)
    shutil.copy2(case_path, inputs / "case.json")
    artifact: dict[str, Any] | None = None
    if artifact_path:
        artifact_path = artifact_path.resolve()
        if not artifact_path.is_file():
            raise RunnerError(f"supplied artifact does not exist: {artifact_path}")
        shutil.copy2(artifact_path, inputs / "supplied-artifact")
        artifact = {"path": "inputs/supplied-artifact", "sha256": sha256(artifact_path)}
    run_id = side_dir.name
    started_at = now()
    infrastructure: InfrastructureError | None = None
    exchange_sequence = 0
    transport = transport_factory()
    all_responses: dict[str, Any] = {}
    try:
        transport.start_members(members, project)
        worker_members = [member for member in members if member.get("role") == "worker"]
        judge_members = [member for member in members if member.get("role") == "judge"]
        chair_members = [member for member in members if member.get("role") == "chair"]
        if worker_members:
            worker = worker_members[0]
            exchange_sequence += 1
            request = request_id(run_id, worker["name"], exchange_sequence)
            start = time.monotonic()
            completion = transport.request(worker["name"], request, build_payload(worker, case, artifact), timeout_ms)
            record_exchange(side_dir, worker["name"], request, build_payload(worker, case, artifact), completion, exchange_sequence)
            write_json(side_dir / "members" / member_path(worker["name"]) / "timing.json", make_timing(worker["name"], start, time.monotonic(), usage=completion.usage))
            all_responses[worker["name"]] = completion.payload
            artifact = completion.payload
        if judge_members:
            independent: dict[str, Any] = {}
            for judge in judge_members:
                exchange_sequence += 1
                request = request_id(run_id, judge["name"], exchange_sequence)
                payload = build_payload(judge, case, artifact)
                start = time.monotonic()
                completion = transport.request(judge["name"], request, payload, timeout_ms)
                record_exchange(side_dir, judge["name"], request, payload, completion, exchange_sequence)
                write_json(side_dir / "members" / member_path(judge["name"]) / "timing.json", make_timing(judge["name"], start, time.monotonic(), usage=completion.usage))
                independent[judge["name"]] = completion.payload
                all_responses[judge["name"]] = completion.payload
            if chair_members:
                chair = chair_members[0]
                exchange_sequence += 1
                request = request_id(run_id, chair["name"], exchange_sequence)
                payload = build_payload(chair, case, artifact, independent)
                start = time.monotonic()
                completion = transport.request(chair["name"], request, payload, timeout_ms)
                record_exchange(side_dir, chair["name"], request, payload, completion, exchange_sequence)
                write_json(side_dir / "members" / member_path(chair["name"]) / "timing.json", make_timing(chair["name"], start, time.monotonic(), usage=completion.usage))
                all_responses[chair["name"]] = completion.payload
        if not judge_members and not worker_members:
            for member in members:
                exchange_sequence += 1
                request = request_id(run_id, member["name"], exchange_sequence)
                payload = build_payload(member, case, artifact)
                start = time.monotonic()
                completion = transport.request(member["name"], request, payload, timeout_ms)
                record_exchange(side_dir, member["name"], request, payload, completion, exchange_sequence)
                write_json(side_dir / "members" / member_path(member["name"]) / "timing.json", make_timing(member["name"], start, time.monotonic(), usage=completion.usage))
                all_responses[member["name"]] = completion.payload
        deliverable = all_responses.get(chair_members[0]["name"]) if chair_members else (all_responses.get(judge_members[0]["name"]) if judge_members else next(iter(all_responses.values()), {}))
        write_json(outputs / "deliverable.json", deliverable if isinstance(deliverable, dict) else {"value": deliverable})
    except KeyboardInterrupt:
        infrastructure = CancelledFailure("run interrupted")
    except (InfrastructureError, OSError, ValueError) as error:
        infrastructure = error if isinstance(error, InfrastructureError) else InfrastructureError(str(error))
    finally:
        try:
            transport.stop_all(timeout_ms)
        except Exception as error:  # cleanup failure is infrastructure evidence
            infrastructure = InfrastructureError(f"cleanup failure: {error}")
        for member in members:
            member_dir = side_dir / "members" / member_path(member["name"])
            timing_path = member_dir / "timing.json"
            if not timing_path.exists():
                current = time.time()
                write_json(member_dir / "timing.json", make_timing(member["name"], current, current, "failed" if infrastructure else "unknown"))
            transcript_path = member_dir / "transcript.jsonl"
            if not transcript_path.exists():
                append_jsonl(transcript_path, {"schemaVersion": SCHEMA_VERSION, "eventId": f"{run_id}-{member_path(member['name'])}-unstarted", "sequence": 1, "timestamp": now(), "member": member["name"], "kind": "error", "content": "member did not produce a correlated completion"})
            stderr_path = member_dir / "stderr.log"
            if not stderr_path.exists():
                stderr_path.write_text("", encoding="utf-8")
    ended_at = now()
    grading = grade_run(case, side_dir, infrastructure, grader)
    terminal_status = "infrastructure_error" if infrastructure else ("passed" if grading["terminalResult"] == "passed" else "assertion_failed")
    run = {
        "schemaVersion": SCHEMA_VERSION,
        "evalId": case.get("evalId", "crew-eval"),
        "caseId": case["caseId"],
        "runId": run_id,
        "comparisonSide": "with_crew" if configuration.get("kind") == "with_crew" else "baseline",
        "repetition": int(configuration.get("repetition", 1)),
        "templateSnapshot": {"path": template_path.name, "sha256": sha256(template_path)},
        "manifest": {"path": "project/.pi/bebop/crew.json", "sha256": sha256(copied_manifest)},
        "members": [{"name": member["name"], "role": member.get("role", ""), **models[member["name"]], "configurationSource": "runner"} for member in members],
        "runnerVersion": "task-0198-1.0",
        "timeoutMs": timeout_ms,
        "concurrency": {"mode": "serial", "maxMembers": concurrency},
        "startedAt": started_at,
        "endedAt": ended_at,
        "terminalStatus": terminal_status,
        **({"infrastructureError": {"code": "RUN_FAILURE", "summary": str(infrastructure)}} if infrastructure else {}),
    }
    write_json(side_dir / "run.json", run)
    return run


def run_pair(args: argparse.Namespace) -> dict[str, Any]:
    template = args.template
    case_path = args.case_file
    configuration_path = args.configuration
    baseline_path = args.baseline_configuration
    manifest = validate_manifest(template)
    case = validate_case(case_path)
    config = validate_configuration(configuration_path)
    baseline_config = validate_configuration(baseline_path) if baseline_path else None
    if args.timeout_ms < case["timeoutMs"]:
        raise RunnerError("runner timeout must cover the case timeout")
    grader = args.grader_model
    if any(expectation.get("authority") == "semantic" for expectation in case["expectations"]) and grader is None:
        raise RunnerError("semantic assertions require an explicit independent --grader-model")
    models = dict(args.model)
    validate_models(models, manifest["members"])
    if args.adapter == "command":
        validate_commands(dict(args.member_command))
    if not any(member.get("role") == "worker" for member in manifest["members"]) and args.artifact is None:
        raise RunnerError("a Crew without a Worker requires an externally supplied --artifact")
    preflight_pair(case, config, baseline_config)
    root = args.run_directory
    root.mkdir(parents=True)
    try:
        shutil.copy2(case_path, root / "case.json")
        configurations = root / "configurations"
        configurations.mkdir()
        shutil.copy2(configuration_path, configurations / "with_crew.json")
        if baseline_path:
            shutil.copy2(baseline_path, configurations / "baseline.json")
        baseline_models = dict(args.baseline_model or args.model)
        if baseline_path:
            validate_models(baseline_models, manifest["members"])
        for repetition in range(1, args.repetitions + 1):
            candidate_config = {**config, "repetition": repetition}
            run_side(template, case_path, case, candidate_config, root / "with_crew" / f"run-{repetition}", models, args.timeout_ms, args.concurrency, lambda: make_transport(args), args.artifact, grader)
            if baseline_path:
                baseline_run = {**baseline_config, "repetition": repetition}
                run_side(template, case_path, case, baseline_run, root / "baseline" / f"run-{repetition}", baseline_models, args.timeout_ms, args.concurrency, lambda: make_transport(args), args.artifact, grader)
    except Exception:
        if not args.keep_failed:
            shutil.rmtree(root, ignore_errors=True)
        raise
    return {"status": "completed", "runDirectory": str(root)}


def make_transport(args: argparse.Namespace) -> Any:
    if args.adapter == "fake":
        return FakeTransport()
    return ProcessTransport(dict(args.member_command))


def variation(values: list[float]) -> dict[str, float]:
    if not values:
        return {"mean": 0, "stddev": 0, "min": 0, "max": 0}
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return {"mean": mean, "stddev": variance**0.5, "min": min(values), "max": max(values)}


def aggregate(args: argparse.Namespace) -> dict[str, Any]:
    root = args.evaluation_directory
    case = validate_case(root / "case.json")
    sides: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for side_name in ("with_crew", "baseline"):
        runs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        side = root / side_name
        if side.is_dir():
            for run_dir in sorted(item for item in side.iterdir() if item.is_dir()):
                run = load_json(run_dir / "run.json", "run metadata")
                grading = load_json(run_dir / "grading.json", "grading")
                if run.get("terminalStatus") == "infrastructure_error":
                    continue
                runs.append((run, grading))
        if runs:
            sides[side_name] = runs
    if "with_crew" not in sides or "baseline" not in sides:
        raise RunnerError("aggregation requires fresh with_crew and baseline run directories")
    def side_metrics(runs: list[tuple[dict[str, Any], dict[str, Any]]]) -> dict[str, Any]:
        durations: list[float] = []
        tokens: list[float] = []
        messages: list[float] = []
        passes = 0
        errors = 0
        for run, grading in runs:
            if grading.get("terminalResult") == "passed":
                passes += 1
            if grading.get("infrastructure", {}).get("status") == "error":
                errors += 1
            total_duration = 0
            total_messages = 0
            total_tokens = 0
            for member in run.get("members", []):
                timing_path = root / ("with_crew" if run["comparisonSide"] == "with_crew" else "baseline") / run["runId"] / "members" / member_path(member["name"]) / "timing.json"
                timing = load_json(timing_path, "timing")
                total_duration += timing["durationMs"]
                total_messages += timing["messageCount"]
                usage = timing["tokenUsage"]
                if usage["source"] != "provider_report" or usage["total"] is None:
                    raise RunnerError("cannot aggregate unknown token usage; provider-authoritative usage is required")
                total_tokens += usage["total"]
            durations.append(total_duration)
            messages.append(total_messages)
            tokens.append(total_tokens)
        return {"qualityPassRate": {"available": True, "count": passes, "rate": passes / len(runs), "reason": None}, "falseAcceptance": {"available": False, "count": None, "rate": None, "reason": "gold labels are not present"}, "falseRejection": {"available": False, "count": None, "rate": None, "reason": "gold labels are not present"}, "durationMs": variation(durations), "tokens": variation(tokens), "toolCalls": variation([0 for _ in runs]), "messages": variation(messages), "errors": {"total": errors, "infrastructure": errors, "assertion": 0, "codes": []}}
    with_metrics = side_metrics(sides["with_crew"])
    baseline_metrics = side_metrics(sides["baseline"])
    def delta(field: str, unit: str) -> dict[str, Any]:
        left = with_metrics[field]["mean"] if field in ("durationMs", "tokens", "toolCalls", "messages") else with_metrics[field]["rate"]
        right = baseline_metrics[field]["mean"] if field in ("durationMs", "tokens", "toolCalls", "messages") else baseline_metrics[field]["rate"]
        return {"candidateMinusBaseline": left - right, "unit": unit}
    benchmark = {
        "schemaVersion": SCHEMA_VERSION,
        "evalId": case.get("evalId", "crew-eval"),
        "caseId": case["caseId"],
        "comparisonStatus": "valid",
        "repetitions": min(len(sides["with_crew"]), len(sides["baseline"])),
        "withCrew": {"configurationKind": "with_crew", "configurationSha256": sha256(root / "configurations" / "with_crew.json"), "runIds": [run["runId"] for run, _ in sides["with_crew"]], "validRuns": len(sides["with_crew"]), "invalidRuns": 0, "metrics": with_metrics},
        "baseline": {"configurationKind": "single_agent", "configurationSha256": sha256(root / "configurations" / "baseline.json"), "runIds": [run["runId"] for run, _ in sides["baseline"]], "validRuns": len(sides["baseline"]), "invalidRuns": 0, "metrics": baseline_metrics},
        "deltas": {"qualityPassRate": delta("qualityPassRate", "rate"), "falseAcceptance": {"candidateMinusBaseline": None, "unit": "rate"}, "falseRejection": {"candidateMinusBaseline": None, "unit": "rate"}, "durationMs": delta("durationMs", "milliseconds"), "tokens": delta("tokens", "tokens"), "toolCalls": delta("toolCalls", "calls"), "messages": delta("messages", "messages"), "errors": {"candidateMinusBaseline": with_metrics["errors"]["total"] - baseline_metrics["errors"]["total"], "unit": "errors"}},
        "efficiency": {"definition": "correct verdicts per 10k authoritative tokens and per wall-clock minute", "withCrew": {"correctVerdictsPer10kTokens": None, "correctVerdictsPerWallMinute": None, "denominatorReason": "efficiency derivation is deferred to the authoritative report"}, "baseline": {"correctVerdictsPer10kTokens": None, "correctVerdictsPerWallMinute": None, "denominatorReason": "efficiency derivation is deferred to the authoritative report"}, "deltas": {"correctVerdictsPer10kTokens": {"candidateMinusBaseline": None, "unit": "correct verdicts per 10k tokens"}, "correctVerdictsPerWallMinute": {"candidateMinusBaseline": None, "unit": "correct verdicts per wall minute"}}},
    }
    output = args.output or root / "benchmark.json"
    write_json(output, benchmark)
    (root / "benchmark.md").write_text(f"# Crew benchmark\n\n- Candidate runs: {len(sides['with_crew'])}\n- Baseline runs: {len(sides['baseline'])}\n- Quality delta: {benchmark['deltas']['qualityPassRate']['candidateMinusBaseline']:.4f}\n- Duration delta (ms): {benchmark['deltas']['durationMs']['candidateMinusBaseline']:.2f}\n- Message delta: {benchmark['deltas']['messages']['candidateMinusBaseline']:.2f}\n", encoding="utf-8")
    return {"status": "aggregated", "output": str(output)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="preflight and run one isolated case")
    run.add_argument("--template", type=absolute_file, required=True)
    run.add_argument("--case", dest="case_file", type=absolute_file, required=True)
    run.add_argument("--configuration", type=absolute_file, required=True)
    run.add_argument("--baseline-configuration", type=absolute_file)
    run.add_argument("--run-directory", type=fresh_directory, required=True)
    run.add_argument("--artifact", type=absolute_file)
    run.add_argument("--timeout-ms", type=lambda v: bounded_integer(v, "timeout-ms", MAX_TIMEOUT_MS), required=True)
    run.add_argument("--concurrency", type=lambda v: bounded_integer(v, "concurrency", MAX_CONCURRENCY), required=True)
    run.add_argument("--repetitions", type=lambda v: bounded_integer(v, "repetitions", 100), default=1)
    run.add_argument("--model", action="append", type=parse_model, default=[])
    run.add_argument("--baseline-model", action="append", type=parse_model, default=[])
    run.add_argument("--grader-model", type=parse_provider_model, help="explicit independent semantic grader PROVIDER/MODEL")
    run.add_argument("--adapter", choices=("command", "fake"), default="command")
    run.add_argument("--member-command", action="append", type=parse_command, default=[])
    run.add_argument("--keep-failed", action="store_true")
    aggregate_parser = commands.add_parser("aggregate", help="aggregate completed candidate and baseline runs")
    aggregate_parser.add_argument("--evaluation-directory", type=absolute_directory, required=True)
    aggregate_parser.add_argument("--output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            result = run_pair(args)
        else:
            result = aggregate(args)
    except (RunnerError, OSError) as error:
        print(f"crew-eval-runner: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
