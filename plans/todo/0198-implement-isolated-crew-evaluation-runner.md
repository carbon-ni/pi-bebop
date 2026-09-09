---
id: TASK-0198
title: Implement isolated Crew evaluation runner
status: doing
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

- [ ] One case command accepts absolute Template, case, configuration, and fresh run-directory paths plus explicit model settings, timeout, and concurrency bounds.
- [ ] Runner preflights manifest/instructions, fixtures, models, executable dependencies, output directory, and allowed effects before starting any member.
- [ ] Each run uses unique disposable project, Crew layout, sockets, session state, and output paths; it never joins or mutates user's active Crew.
- [ ] Runner starts only configured members, submits same bounded case inputs, identifies declared Crew Deliverable, and stops every child on success, failure, timeout, or interrupt.
- [ ] Council execution preserves Judge independence: neither Judge receives peer judgment before its own terminal response is captured.
- [ ] Completion is an explicit harness event or correlated response, never inferred from online/idle state, notification text, or arbitrary sleep.
- [ ] Core runner uses existing correlated Request/Response semantics or a harness adapter and does not depend on TASK-0174. Any optional black-box `pi-bebop ask` adapter declares TASK-0174 and TASK-0173 dependencies separately.
- [ ] Candidate and baseline execute same case/fixtures and declared compatible settings; runner rejects accidental reuse of candidate artifacts by baseline.
- [ ] Raw member transcripts, message trace, outputs, timing, authoritative model usage, stderr, and terminal status conform to TASK-0197 schemas.
- [ ] Provider failure, unavailable model, malformed response, member crash, route loss, timeout, and cleanup failure remain visible infrastructure errors and never pass negative assertions.
- [ ] Repetitions use fresh directories and retain variance; aggregator does not overwrite or average away individual runs.
- [ ] Aggregator produces deterministic benchmark JSON plus a bounded human review surface showing outputs, grades, cost/latency, message overhead, errors, and candidate-baseline deltas.
- [ ] Semantic grading uses an explicitly selected independent grader and records its model/settings; deterministic assertions run without a model where possible.
- [ ] Paid executions require user-agreed cases, repetitions, concurrency, and timeouts. Runner documents that process isolation is not filesystem/network sandboxing.
- [ ] Tests use fake child processes/transports for lifecycle, independence, timeout, interrupt, cleanup, schema, aggregation, and failure paths; live smoke test is opt-in and bounded.

## Non-goals

Changing Bebop transport semantics, owning production workflow/task state, guaranteeing provider determinism, hiding disagreement, automatic human escalation, or running untrusted fixtures against production systems.
