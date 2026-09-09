---
id: TASK-0198
title: Implement isolated Crew evaluation runner
status: done
depends_on: [TASK-0196, TASK-0197]
priority: high
tags: [skill, crew, evaluation, runner, isolation, benchmark, tdd]
---

# Implement isolated Crew evaluation runner

## Problem

A documented Template and eval schema still leave users manually starting members, delivering cases, deciding when a run ended, collecting several transcripts, and comparing results. Manual execution is inconsistent and makes coordination overhead invisible.

## Desired outcome

Add bounded runner and aggregation scripts to `skills/crew-creator` that execute candidate and baseline configurations in disposable workspaces, collect authoritative multi-member evidence, grade predeclared expectations, and produce a reviewable benchmark.

## Acceptance criteria

- [x] One case command accepts absolute Template, case, configuration, and fresh run-directory paths plus explicit model settings, timeout, and concurrency bounds.
- [x] Runner preflights manifest/instructions, fixtures, models, executable dependencies, output directory, and allowed effects before starting any member.
- [x] Each run uses unique disposable project, Crew layout, sockets, session state, and output paths; it never joins or mutates user's active Crew.
- [x] Runner starts only configured members, submits same bounded case inputs, identifies declared Crew Deliverable, and stops every child on success, failure, timeout, or interrupt.
- [x] Council execution preserves Judge independence: neither Judge receives peer judgment before its own terminal response is captured.
- [x] Completion is an explicit harness event or correlated response, never inferred from online/idle state, notification text, or arbitrary sleep.
- [x] Core runner uses a harness adapter and does not depend on TASK-0174. No black-box `pi-bebop ask` adapter is included.
- [x] Candidate and baseline execute same case/fixtures and declared compatible settings; runner rejects accidental reuse of candidate artifacts by baseline.
- [x] Raw member transcripts, message trace, outputs, timing, authoritative model usage, stderr, and terminal status conform to TASK-0197 schemas.
- [x] Provider failure, unavailable model, malformed response, member crash, route loss, timeout, and cleanup failure remain visible infrastructure errors and never pass negative assertions.
- [x] Repetitions use fresh directories and retain variance; aggregator does not overwrite or average away individual runs.
- [x] Aggregator produces deterministic benchmark JSON plus a bounded human review surface showing outputs, grades, token/latency, message overhead, errors, and candidate-baseline deltas.
- [x] Semantic grading requires an explicitly selected independent grader and records its model/settings; deterministic assertions run without a model where possible.
- [x] Paid executions require user-agreed cases, repetitions, concurrency, and timeouts. Runner documents that process isolation is not filesystem/network sandboxing.
- [x] Tests use fake child processes/transports for lifecycle, independence, timeout, cleanup, schema, aggregation, and failure paths; live command smoke test is opt-in and bounded.

## Evidence

- Runner: `skills/crew-creator/scripts/crew_eval_runner.py` provides bounded `run` and `aggregate` commands, an explicit command adapter, and deterministic FakeChild/FakeTransport harness.
- Artifact collection: each isolated side/repetition records project manifest, inputs, outputs, per-member JSONL transcripts, timing/token usage, message trace, stderr, grading, and terminal run metadata.
- Focused tests: `python3 -m unittest discover -s skills/crew-creator/scripts -p 'test_*.py'` passes all lifecycle, Judge-independence, isolation, timeout, failure, aggregation, and preflight tests.
- Smoke validation: fake Council candidate/Baseline run with two repetitions and aggregation produces `benchmark.json` and `benchmark.md` without touching the source Crew.
- Scope check: only runner script, runner tests/docs, and this plan changed; no Bebop source/transport, existing Template, or unrelated feature changed.
- Pre-commit validation and `git diff --check` pass.

## Non-goals

Changing Bebop transport semantics, owning production workflow/task state, guaranteeing provider determinism, hiding disagreement, automatic human escalation, or running untrusted fixtures against production systems.
