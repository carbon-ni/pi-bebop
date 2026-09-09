#!/usr/bin/env python3
"""Bounded, isolated Crew-evaluation preflight and run-workspace initializer."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


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


def read_json(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {label}: {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"invalid {label}: expected JSON object")
    return value


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=absolute_file, required=True)
    parser.add_argument("--case", dest="case_file", type=absolute_file, required=True)
    parser.add_argument("--configuration", type=absolute_file, required=True)
    parser.add_argument("--run-directory", type=fresh_directory, required=True)
    parser.add_argument("--timeout-ms", type=int, required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    parser.add_argument("--model", action="append", default=[], metavar="MEMBER=PROVIDER/MODEL")
    args = parser.parse_args(argv)
    if not 1 <= args.timeout_ms <= 3_600_000 or not 1 <= args.concurrency <= 128:
        parser.error("timeout and concurrency must be bounded positive values")

    template = read_json(args.template, "template manifest")
    case = read_json(args.case_file, "evaluation case")
    configuration = read_json(args.configuration, "configuration")
    members = template.get("members")
    if not isinstance(members, list) or not members:
        raise ValueError("template manifest must declare members")
    if case.get("schemaVersion") != "1.0":
        raise ValueError("case must use TASK-0197 schemaVersion 1.0")
    if not args.model:
        raise ValueError("explicit member model settings are required")

    root = args.run_directory
    root.mkdir(parents=True)
    try:
        (root / "with_crew").mkdir()
        (root / "baseline").mkdir()
        (root / "inputs").mkdir()
        shutil.copy2(args.case_file, root / "inputs" / "case.json")
        metadata = {
            "schemaVersion": "1.0",
            "terminalStatus": "preflighted",
            "template": str(args.template),
            "case": str(args.case_file),
            "configuration": str(args.configuration),
            "timeoutMs": args.timeout_ms,
            "concurrency": args.concurrency,
            "models": args.model,
        }
        (root / "preflight.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise
    print(json.dumps({"status": "preflighted", "runDirectory": str(root)}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as error:
        print(f"crew-eval-runner: {error}", file=sys.stderr)
        raise SystemExit(2)
