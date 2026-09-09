#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import crew_eval_runner as runner


ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / "skills/crew-creator/assets/templates/council-of-models/crew.json"


class InterruptTransport(runner.FakeTransport):
    def request(self, member, request, payload, timeout_ms):
        raise KeyboardInterrupt()


class CleanupFailureTransport(runner.FakeTransport):
    def stop_all(self, timeout_ms):
        super().stop_all(timeout_ms)
        raise RuntimeError("cleanup failed")


class RunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.case = self.root / "case.json"
        self.config = self.root / "config.json"
        self.artifact = self.root / "artifact.json"
        self.case.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "caseId": "case-1",
                    "prompt": "Review this artifact",
                    "fixturePaths": [],
                    "expectedDeliverable": {"id": "verdict", "kind": "verdict", "selector": "$.finalVerdict", "description": "Chair verdict"},
                    "expectations": [{"id": "output", "authority": "deterministic", "kind": "required_file", "path": "outputs/deliverable.json", "description": "output exists", "onFailure": "fail_assertion"}],
                    "allowedEffects": {"files": [], "commands": [], "network": "none"},
                    "timeoutMs": 1000,
                }
            )
            + "\n"
        )
        self.config.write_text('{"schemaVersion":"1.0","kind":"with_crew","name":"candidate"}\n')
        self.artifact.write_text('{"release":"1","evidence":"fixture"}\n')
        self.models = {
            "Chair": {"provider": "fake", "model": "chair", "thinking": "default"},
            "Judge A": {"provider": "fake", "model": "judge-a", "thinking": "default"},
            "Judge B": {"provider": "fake", "model": "judge-b", "thinking": "default"},
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_council_judges_are_independent_until_chair(self) -> None:
        transport = runner.FakeTransport()
        case = runner.validate_case(self.case)
        config = runner.validate_configuration(self.config)
        side = self.root / "with_crew" / "run-1"
        result = runner.run_side(TEMPLATE, self.case, case, config, side, self.models, 1000, 3, lambda: transport, self.artifact)
        self.assertEqual(result["terminalStatus"], "passed")
        judge_payloads = [payload for member, _, payload in transport.requests if member in ("Judge A", "Judge B")]
        self.assertEqual(len(judge_payloads), 2)
        self.assertNotIn("independentJudgments", judge_payloads[0])
        self.assertNotIn("independentJudgments", judge_payloads[1])
        chair_payload = next(payload for member, _, payload in transport.requests if member == "Chair")
        self.assertEqual(set(chair_payload["independentJudgments"]), {"Judge A", "Judge B"})
        self.assertTrue(transport.stopped)
        self.assertEqual(transport.started, ["Chair", "Judge A", "Judge B"])
        self.assertTrue((side / "members" / "Judge_A" / "transcript.jsonl").is_file())
        self.assertTrue((side / "members" / "Chair" / "timing.json").is_file())

    def test_failure_is_infrastructure_and_stops_children(self) -> None:
        transport = runner.FakeTransport(failures={"Judge B": "route lost"})
        side = self.root / "with_crew" / "run-1"
        result = runner.run_side(TEMPLATE, self.case, runner.validate_case(self.case), runner.validate_configuration(self.config), side, self.models, 1000, 3, lambda: transport, self.artifact)
        self.assertEqual(result["terminalStatus"], "infrastructure_error")
        grading = json.loads((side / "grading.json").read_text())
        self.assertEqual(grading["terminalResult"], "invalid_infrastructure")
        self.assertEqual(grading["infrastructure"]["status"], "error")
        self.assertTrue((side / "members" / "Judge_B" / "timing.json").is_file())
        self.assertTrue((side / "members" / "Judge_B" / "transcript.jsonl").is_file())
        self.assertTrue(transport.stopped)

    def test_pair_uses_fresh_candidate_and_baseline_directories(self) -> None:
        baseline = self.root / "baseline.json"
        baseline.write_text('{"schemaVersion":"1.0","kind":"single_agent","name":"baseline"}\n')
        output = self.root / "evaluation"
        args = SimpleNamespace(
            template=TEMPLATE,
            case_file=self.case,
            configuration=self.config,
            baseline_configuration=baseline,
            run_directory=output,
            artifact=self.artifact,
            timeout_ms=1000,
            concurrency=3,
            repetitions=2,
            model=list(self.models.items()),
            baseline_model=[],
            grader_model=None,
            adapter="fake",
            member_command=[],
            keep_failed=False,
        )
        result = runner.run_pair(args)
        self.assertEqual(result["status"], "completed")
        for side in ("with_crew", "baseline"):
            self.assertTrue((output / side / "run-1" / "project" / ".pi" / "bebop" / "crew.json").is_file())
            self.assertTrue((output / side / "run-2" / "run.json").is_file())
        self.assertEqual(len(list((output / "with_crew").glob("run-*"))), 2)
        self.assertEqual(len(list((output / "baseline").glob("run-*"))), 2)
        result = runner.aggregate(SimpleNamespace(evaluation_directory=output, output=None))
        self.assertEqual(result["status"], "aggregated")
        benchmark = json.loads((output / "benchmark.json").read_text())
        self.assertEqual(benchmark["comparisonStatus"], "valid")
        self.assertIn("candidateMinusBaseline", benchmark["deltas"]["messages"])
        self.assertTrue((output / "benchmark.md").is_file())

    def test_interrupt_and_cleanup_failure_are_infrastructure_errors(self) -> None:
        for transport in (InterruptTransport(), CleanupFailureTransport()):
            side = self.root / transport.__class__.__name__ / "run-1"
            result = runner.run_side(TEMPLATE, self.case, runner.validate_case(self.case), runner.validate_configuration(self.config), side, self.models, 1000, 3, lambda transport=transport: transport, self.artifact)
            self.assertEqual(result["terminalStatus"], "infrastructure_error")
            grading = json.loads((side / "grading.json").read_text())
            self.assertEqual(grading["terminalResult"], "invalid_infrastructure")

    def test_preflight_rejects_reused_output_and_missing_artifact(self) -> None:
        candidate = {"outputDirectory": str(self.root / "same")}
        baseline = {"outputDirectory": str(self.root / "same")}
        with self.assertRaises(runner.RunnerError):
            runner.preflight_pair({}, candidate, baseline)
        with self.assertRaises(runner.RunnerError):
            runner.preflight_pair({}, {"artifactPath": str(self.artifact)}, {"artifactPath": str(self.artifact)})

    def test_command_transport_timeout_is_bounded(self) -> None:
        transport = runner.ProcessTransport({"member": ["python3", "-c", "import time; time.sleep(2)"]})
        transport.start_members([{"name": "member"}], self.root)
        started = time.monotonic()
        with self.assertRaises(runner.TimeoutFailure):
            transport.request("member", "request-1", {}, 50)
        transport.stop_all(100)
        self.assertLess(time.monotonic() - started, 1)


if __name__ == "__main__":
    unittest.main()
