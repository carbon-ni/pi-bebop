#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import tempfile
import time
import unittest
from pathlib import Path

import crew_intake_smoke as harness


class FakeAdapter:
    def __init__(self, *, tmux_version: str = "tmux 3.5") -> None:
        self.tmux_version = tmux_version
        self.calls: list[tuple[list[str], Path | None]] = []
        self.panes = 0
        self.sessions: set[str] = set()
        self.pane_titles: dict[str, str] = {}
        self.claimed_sockets: set[str] = set()
        self.capture_text = "bounded pane evidence\n"
        self.fail_command: str | None = None
        self.exes = {"pi": "/fake/pi", "tmux": "/fake/tmux"}

    def executable(self, name: str) -> str | None:
        return self.exes.get(name)

    def run(self, argv, *, cwd=None, timeout=None, check=False):
        command = list(argv)
        self.calls.append((command, cwd))
        args = command[1:]
        if self.fail_command and args and args[0] == self.fail_command:
            return harness.CommandResult(1, "", "simulated command failure")
        if args == ["-V"]:
            return harness.CommandResult(0, self.tmux_version + "\n", "")
        if args and args[0] == "has-session":
            return harness.CommandResult(0 if args[-1] in self.sessions else 1, "", "")
        if args and args[0] in ("new-session", "split-window"):
            self.panes += 1
            pane = f"%{self.panes}"
            if args[0] == "new-session":
                self.sessions.add(args[args.index("-s") + 1])
            rendered = args[-1]
            parsed = shlex.split(rendered)
            if "--crew-role" in parsed:
                role = parsed[parsed.index("--crew-role") + 1]
                session_dir = Path(parsed[parsed.index("--session-dir") + 1])
                socket_path = session_dir.parent.parent / "project" / ".pi" / "bebop" / "sockets" / f"{role.lower()}.sock"
                self.claimed_sockets.add(str(socket_path))
            return harness.CommandResult(0, pane + "\n", "")
        if args and args[0] == "select-pane" and "-T" in args:
            self.pane_titles[args[args.index("-t") + 1]] = args[args.index("-T") + 1]
            return harness.CommandResult(0, "", "")
        if args and args[0] == "list-panes":
            rows = [f"{pane}\t{self.pane_titles.get(pane, '')}\t123\t0\tpi" for pane in sorted(self.pane_titles)]
            return harness.CommandResult(0, "\n".join(rows) + ("\n" if rows else ""), "")
        if args and args[0] == "capture-pane":
            return harness.CommandResult(0, self.capture_text, "")
        if args and args[0] == "kill-session":
            self.sessions.discard(args[-1])
            self.claimed_sockets.clear()
            return harness.CommandResult(0, "", "")
        return harness.CommandResult(0, "", "")


class IntakeHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.extension = self.root / "extension.js"
        self.cli = self.root / "cli.js"
        self.extension.write_text("extension", encoding="utf-8")
        self.cli.write_text("cli", encoding="utf-8")
        self.adapter = FakeAdapter()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def options(self, **changes):
        values = {
            "run_dir": str(self.root / "run"),
            "run_root": str(self.root),
            "case": "online",
            "provider": "fake",
            "model": "provider/model",
            "thinking": "off",
            "extension": str(self.extension),
            "cli": str(self.cli),
            "pi": "pi",
            "tmux": "tmux",
            "session_name": "smoke-session",
            "timeout_ms": 1000,
        }
        values.update(changes)
        return type("Options", (), values)()

    def test_start_isolated_and_contains_no_model_call_flags(self) -> None:
        state = harness.create_run(self.options(), self.adapter)
        self.assertEqual(sorted(state["members"]), ["Contact", "Peer"])
        manifest_path = self.root / "run" / "project" / ".pi" / "bebop" / "crew.json"
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["intake"], {"contact": "Contact"})
        self.assertEqual(manifest["commonInstructionsFile"], "instructions/common.md")
        self.assertEqual([member["socket"] for member in manifest["members"]], ["sockets/contact.sock", "sockets/peer.sock"])
        guide = (self.root / "run" / "project" / ".pi" / "bebop" / "intake" / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("external transport boundary, not the crew Inbox", guide)
        self.assertIn("997,952 UTF-8 bytes", guide)
        self.assertIn("160 UTF-8 bytes", guide)
        self.assertIn(".pi/bebop/intake/processed/", guide)
        self.assertIn(".pi/bebop/sockets/", guide)
        self.assertIn(".pi/bebop/inbox/", guide)
        self.assertIn("does not prove that the content was read", guide)
        harness.validate_manifest_paths(manifest, manifest_path)
        for directory in (self.root / "run" / "project", self.root / "run" / "project" / ".pi", self.root / "run" / "project" / ".pi" / "bebop", self.root / "run" / "project" / ".pi" / "bebop" / "intake"):
            self.assertEqual(directory.stat().st_mode & 0o077, 0, str(directory))
        invalid = dict(manifest, commonInstructionsFile="../instructions/common.md")
        with self.assertRaises(harness.HarnessError):
            harness.validate_manifest_paths(invalid, manifest_path)
        pi_commands = [call[0] for call in self.adapter.calls if "/fake/pi" in call[0]]
        self.assertEqual(len(pi_commands), 0, "Pi commands are handed to tmux, not executed by the harness")
        rendered = " ".join(" ".join(call[0]) for call in self.adapter.calls)
        pi_rendered = " ".join(" ".join(call[0]) for call in self.adapter.calls if "exec /fake/pi" in " ".join(call[0]))
        self.assertIn("--crew-role Contact", pi_rendered)
        self.assertIn("--crew-role Peer", pi_rendered)
        self.assertIn("--provider fake", pi_rendered)
        self.assertIn("--model provider/model", pi_rendered)
        self.assertIn("--thinking off", pi_rendered)
        self.assertNotIn(" --print", pi_rendered)
        self.assertNotIn(" -p", pi_rendered)

    def test_preflight_rejects_old_tmux_before_creating_run(self) -> None:
        self.adapter.tmux_version = "tmux 3.4"
        with self.assertRaises(harness.HarnessError):
            harness.create_run(self.options(), self.adapter)
        self.assertFalse((self.root / "run").exists())

    def test_existing_run_root_is_reusable_without_touching_contents(self) -> None:
        run_root = self.root / "run-root"
        run_root.mkdir(mode=0o700)
        marker = run_root / "keep.txt"
        marker.write_text("preserve", encoding="utf-8")
        state = harness.create_run(self.options(run_dir=None, run_root=str(run_root)), self.adapter)
        self.assertTrue(marker.exists())
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")
        self.assertEqual(Path(state["runDirectory"]).parent.resolve(), run_root.resolve())

    def test_run_root_rejects_symlink_and_non_directory(self) -> None:
        target = self.root / "target"
        target.mkdir(mode=0o700)
        link = self.root / "link"
        try:
            link.symlink_to(target, target_is_directory=True)
        except (NotImplementedError, OSError):
            self.skipTest("symlinks are unavailable")
        with self.assertRaises(harness.HarnessError):
            harness.create_run(self.options(run_dir=None, run_root=str(link)), self.adapter)
        file_root = self.root / "not-a-directory"
        file_root.write_text("not a directory", encoding="utf-8")
        with self.assertRaises(harness.HarnessError):
            harness.create_run(self.options(run_dir=None, run_root=str(file_root)), self.adapter)
        writable_root = self.root / "world-writable"
        writable_root.mkdir(mode=0o700)
        writable_root.chmod(0o777)
        with self.assertRaises(harness.HarnessError):
            harness.create_run(self.options(run_dir=None, run_root=str(writable_root)), self.adapter)

    def test_publish_is_bounded_atomic_and_rejects_path_injection(self) -> None:
        state = harness.create_run(self.options(), self.adapter)
        source = self.root / "fixture.md"
        source.write_bytes(b"# fixed intake\n")
        result = harness.publish(Path(state["runDirectory"]), source, "case.md")
        self.assertEqual(result["status"], "published")
        new = Path(state["intake"]) / "new"
        self.assertEqual([item.name for item in new.iterdir()], ["case.md"])
        self.assertFalse(any(item.name.endswith(".draft") for item in new.iterdir()))
        with self.assertRaises(harness.HarnessError):
            harness.publish(Path(state["runDirectory"]), source, "../escape.md")
        oversized = self.root / "large.txt"
        oversized.write_bytes(b"x" * (harness.MAX_FILE_BYTES + 1))
        with self.assertRaises(harness.HarnessError):
            harness.publish(Path(state["runDirectory"]), oversized, "large.txt")

    def test_contact_joins_later_and_attach_is_observable(self) -> None:
        state = harness.create_run(self.options(case="contact-joins-later"), self.adapter)
        self.assertEqual(sorted(state["members"]), ["Peer"])
        result = harness.attach_role(Path(state["runDirectory"]), "Contact", self.adapter)
        self.assertEqual(result["status"], "attached")
        status = harness.observe(Path(state["runDirectory"]), self.adapter)
        self.assertEqual(sorted(status["members"]), ["Contact", "Peer"])
        self.assertIn("socketExists", status["members"]["Contact"])

    def test_observable_wait_has_a_finite_deadline(self) -> None:
        state = harness.create_run(self.options(), self.adapter)
        with self.assertRaises(harness.HarnessError):
            harness.wait_for(Path(state["runDirectory"]), "processed", 1, self.adapter)

    def test_capture_is_bounded_and_redacts_sensitive_config_keys_and_text(self) -> None:
        state = harness.create_run(self.options(), self.adapter)
        state["apiKey"] = "do-not-capture"
        harness.atomic_json(Path(state["runDirectory"]) / "state.json", state)
        self.adapter.capture_text = "keep this prose Authorization: Bearer super-secret-token-12345 token=plain-secret sk-live_123456789\n"
        result = harness.capture(Path(state["runDirectory"]), self.adapter, 128)
        evidence = json.loads((Path(result["directory"]) / "evidence.json").read_text())
        pane_text = (Path(result["directory"]) / "contact.txt").read_text()
        self.assertEqual(evidence["state"]["apiKey"], "<redacted>")
        self.assertNotIn("super-secret-token-12345", pane_text)
        self.assertNotIn("plain-secret", pane_text)
        self.assertNotIn("sk-live_123456789", pane_text)
        self.assertIn("keep this prose", pane_text)
        self.assertLessEqual(evidence["panes"]["Contact"]["bytes"], 128)

    def test_partial_start_writes_bounded_failure_evidence_and_kills_session(self) -> None:
        self.adapter.fail_command = "split-window"
        run_dir = self.root / "failed-run"
        with self.assertRaises(harness.HarnessError):
            harness.create_run(self.options(run_dir=str(run_dir), session_name="failed-session"), self.adapter)
        failure = json.loads((run_dir / "failure.json").read_text())
        self.assertEqual(failure["status"], "startup-failure")
        self.assertEqual(failure["cleanup"], "tmux-session-terminated")
        self.assertEqual(failure["membersStarted"], ["Contact"])
        self.assertFalse(self.adapter.sessions)
        self.assertNotIn("simulated command failure", failure)

    def test_stop_is_idempotent_and_removes_only_when_requested(self) -> None:
        state = harness.create_run(self.options(), self.adapter)
        run_dir = Path(state["runDirectory"])
        first = harness.stop(run_dir, self.adapter)
        second = harness.stop(run_dir, self.adapter)
        self.assertFalse(first["removed"])
        self.assertTrue(second["stopWasIdempotent"])
        removed = self.root / "removed"
        state = harness.create_run(self.options(run_dir=str(removed), session_name="remove-session"), self.adapter)
        result = harness.stop(Path(state["runDirectory"]), self.adapter, remove=True)
        self.assertTrue(result["removed"])
        self.assertFalse(removed.exists())
        self.assertEqual(harness.stop(removed, self.adapter, remove=True)["status"], "already-removed")

    @unittest.skipUnless(os.environ.get("CREW_INTAKE_REAL_TMUX_SMOKE") == "1", "opt-in real tmux smoke")
    def test_opt_in_real_tmux_startup_readiness_without_model_call(self) -> None:
        # This test intentionally starts no prompt and uses --offline. It must
        # be explicitly opted into because it opens a real interactive tmux run.
        import shutil

        if not shutil.which("pi") or not shutil.which("tmux"):
            self.skipTest("pi and tmux are required")
        repo = Path(__file__).resolve().parents[3]
        extension = repo / "dist" / "extension.js"
        cli = repo / "dist" / "cli" / "main.js"
        if not extension.is_file() or not cli.is_file():
            self.skipTest("built Bebop extension and CLI are required")
        run_dir = self.root / "real-run"
        options = self.options(run_dir=str(run_dir), session_name="real-intake-smoke", extension=str(extension), cli=str(cli), provider="google", model="gemini-2.5-flash", timeout_ms=30_000)
        adapter = harness.SystemAdapter()
        try:
            state = harness.create_run(options, adapter)
            status = harness.observe(run_dir, adapter)
            self.assertEqual(status["status"], "running")
            self.assertTrue(any(member["title"] == "Control / evidence" for member in status["panes"]))
            live_panes = {member["paneId"] for member in status["panes"] if not member["dead"]}
            self.assertTrue(all(status["members"][role]["paneId"] in live_panes for role in ("Contact", "Peer")))
            self.assertTrue(all(status["members"][role]["socketExists"] for role in ("Contact", "Peer")))
            for role in ("Contact", "Peer"):
                pane_id = state["members"][role]["paneId"]
                self.assertFalse(any(marker in harness.capture_pane_tail(adapter, "tmux", pane_id).lower() for marker in harness.STARTUP_ERROR_MARKERS))
            fixture = run_dir.parent / "no-prompt-fixture.md"
            fixture.write_text("offline startup smoke intake", encoding="utf-8")
            harness.publish(run_dir, fixture, "intake.md")
            processed = run_dir / "project" / ".pi" / "bebop" / "intake" / "processed" / "intake.md"
            for _ in range(300):
                if processed.exists():
                    break
                time.sleep(0.1)
            self.assertTrue(processed.exists(), "actual extension did not move Intake to processed")
            contact_pane = harness.capture_pane_tail(adapter, "tmux", state["members"]["Contact"]["paneId"])
            peer_pane = harness.capture_pane_tail(adapter, "tmux", state["members"]["Peer"]["paneId"])
            self.assertIn("offline startup smoke intake", contact_pane)
            self.assertNotIn("offline startup smoke intake", peer_pane)
        except Exception:
            if (run_dir / "failure.json").exists():
                failure = json.loads((run_dir / "failure.json").read_text())
                self.assertEqual(failure["status"], "startup-failure")
            raise
        finally:
            if run_dir.exists():
                harness.stop(run_dir, adapter)


if __name__ == "__main__":
    unittest.main()
