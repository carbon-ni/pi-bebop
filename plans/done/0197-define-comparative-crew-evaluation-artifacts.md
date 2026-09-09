---
id: TASK-0197
title: Define comparative Crew evaluation artifacts
status: done
depends_on: [TASK-0195]
priority: high
tags: [skill, crew, evaluation, schema, benchmark, metrics, determinism]
---

# Define comparative Crew evaluation artifacts

## Problem

Crew quality cannot be compared reliably when prompts, models, repetitions, completion signals, evidence, and costs are recorded differently for each experiment. A Crew eval needs stable case, run, grading, and benchmark artifacts similar to skill evals, extended for multiple members and messages.

## Desired outcome

Define versioned, machine-validated artifacts for `skills/crew-creator` that support candidate-versus-baseline comparisons, per-member evidence, aggregate Crew cost, repeated runs, and honest infrastructure failures.

## Proposed workspace shape

```text
iteration-1/
└── eval-1-descriptive-name/
    ├── eval_metadata.json
    ├── with_crew/run-1/
    │   ├── run.json
    │   ├── members/<member>/transcript.jsonl
    │   ├── members/<member>/timing.json
    │   ├── message-trace.jsonl
    │   ├── outputs/
    │   └── grading.json
    └── baseline/run-1/
```

## Acceptance criteria

- [x] `crew-evals.json` schema defines stable case ID, prompt, optional fixture paths, expected deliverable, predeclared expectations, allowed effects, timeout, and baseline intent.
- [x] Run metadata records exact Template snapshot/hash, manifest, member-to-model configuration, provider/model/thinking values, runner version, repetition, start/end time, and terminal status.
- [x] Workspace separates `with_crew` and explicit `baseline`; metadata says whether baseline is single agent or prior Crew Template snapshot.
- [x] Each member has a distinct raw transcript and authoritative timing/token record; Crew totals are derived without character-count token estimates.
- [x] Bounded message trace records sender, recipient, delivery kind, correlation where public, and timing while excluding socket paths, credentials, private prompt content not needed for review, and unrelated session traffic.
- [x] One declared Crew Deliverable is graded against same expectations as baseline; missing or ambiguous deliverable is a failed assertion unless run itself is invalid.
- [x] Grading separates assertion results from infrastructure status and cites exact output/transcript/message evidence.
- [x] Benchmark aggregates pass rate, false acceptance/rejection where gold labels exist, duration, tokens, tool calls, messages, errors, and mean/stddev/min/max across repetitions.
- [x] Comparison reports absolute values and candidate-minus-baseline deltas; it never declares efficiency from quality alone.
- [x] At least one normalized efficiency view is defined, such as correct verdicts per 10k tokens and per wall-clock minute, alongside raw metrics.
- [x] Same-case comparisons require fixed fixtures, compatible model settings, equal external permissions, and declared concurrency; invalid comparisons fail validation.
- [x] Schemas reject unknown required-contract fields, path escapes, reused run directories, malformed transcripts, missing model metadata, and nonterminal runs.
- [x] Artifact design can reuse compatible skill-creator grading/viewer fields but documents every Crew-specific extension and avoids silent schema coercion.

## Evidence

- Artifact contract: [`skills/crew-creator/evals/README.md`](../../skills/crew-creator/evals/README.md).
- Machine-readable schemas: `skills/crew-creator/evals/schemas/*.schema.json` cover cases, metadata, runs, transcripts, timing, message traces, grading, and benchmarks.
- Focused validation: every schema parses as JSON; all schema `$ref` targets resolve; every object contract closes unknown fields with `additionalProperties: false`; Prettier and `git diff --check` pass.
- Scope check: changed files are only `skills/crew-creator/evals/**` and this plan; no skill instructions, Council template assets, eval runner, model invocation, source/runtime, or Bebop transport changed.
- Cross-artifact rules document rejection of path escapes, reused run directories, mismatched candidate/Baseline inputs, malformed/nonterminal runs, missing model metadata, infrastructure-as-negative grading, and silent coercion.

## Non-goals

Executing models, deciding universal pass thresholds, estimating monetary cost without explicit price input, storing credentials, publishing eval artifacts, or treating transcripts as a security sandbox.
