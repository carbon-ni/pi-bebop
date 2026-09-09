# Comparative Crew evaluation artifacts

Status: versioned artifact contract for TASK-0197. These files define data
that an external evaluation harness can validate and aggregate. They do not
start models, invoke providers, create Crew sessions, or implement a runner.

## Workspace

One evaluation keeps candidate and baseline artifacts separate:

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
        └── ...
```

`with_crew` is the candidate side. `baseline` is always explicit and is either
`single_agent` or `prior_template`; an absent Crew is not a baseline. Every run
directory is fresh and has one immutable `run.json`. A repetition never reuses a
run directory.

## Schemas

- [`crew-evals.schema.json`](schemas/crew-evals.schema.json) — top-level
  cases, fixed inputs, expected Deliverable, predeclared assertions, allowed
  effects, timeout, and Baseline intent.
- [`eval-metadata.schema.json`](schemas/eval-metadata.schema.json) — one
  evaluation identity, candidate/Baseline references, compatible settings,
  repetitions, and declared concurrency.
- [`run.schema.json`](schemas/run.schema.json) — immutable per-run metadata,
  Template/manifest hashes, member-to-model settings, timing, repetition, and
  terminal status.
- [`transcript-event.schema.json`](schemas/transcript-event.schema.json) — one
  member transcript JSONL record.
- [`timing.schema.json`](schemas/timing.schema.json) — one member's timing and
  provider-authoritative usage record.
- [`message-trace-event.schema.json`](schemas/message-trace-event.schema.json)
  — one bounded message event without content, endpoints, credentials, or
  unrelated session traffic.
- [`grading.schema.json`](schemas/grading.schema.json) — Deliverable, assertion
  outcomes, evidence references, and infrastructure status.
- [`benchmark.schema.json`](schemas/benchmark.schema.json) — repeated-run
  aggregates, candidate-minus-Baseline deltas, errors, and normalized
  efficiency views.
- [`runtime-checkpoint.schema.json`](schemas/runtime-checkpoint.schema.json) —
  the runtime Judge extension: checkpoint decision, Host transitions, latency,
  provider-authoritative tokens, bounded retries, and terminal outcome.

All schemas use JSON Schema 2020-12, require `schemaVersion: "1.0"`, and set
`additionalProperties: false` on contract objects. Unknown fields are rejected;
callers must update the schema version rather than silently coercing data.
JSONL artifacts validate each line as one instance of their corresponding event
schema.

## Validation rules beyond one JSON document

A JSON Schema validator handles shape and bounded values. The harness MUST also
reject these cross-artifact violations before grading:

1. `caseId` and `evalId` must match across metadata, runs, grading, and
   benchmark artifacts.
2. Every run path must be unique, must remain below the evaluation directory,
   and must not contain `..`, an absolute path, a symlink escape, or a path used
   by another repetition.
3. Candidate and Baseline must use the same Case prompt and fixture bytes,
   compatible model settings, equal external permissions, equal timeout and
   resource bounds, and declared concurrency. Any intentional difference must
   be recorded in `compatibility.differences`; otherwise validation fails.
4. Candidate and Baseline must not share output directories or candidate-
   produced fixtures. A run is not valid until all required member metadata,
   transcript lines, timing records, and terminal statuses exist.
5. A run with `terminalStatus` `nonterminal` is invalid. A provider failure,
   unavailable model, malformed response, route loss, timeout, crash, or cleanup
   failure is an infrastructure error, never a passing negative assertion.
6. Every grading assertion ID must be declared by the Case before output is
   inspected. Deterministic assertions run before `gold` and `semantic`
   assertions. Missing or ambiguous required Deliverables fail the assertion
   unless the Run itself is invalid infrastructure.
7. Evidence references must resolve to exact output, transcript, timing, or
   message-trace records. They must not expose socket paths, credentials,
   private prompt content not needed for review, or unrelated session traffic.
8. Crew totals are derived from member timing/message records. Token counts must
   come from the provider boundary (`provider_report`) or be `unknown`; character
   counts are never token estimates. Unknown usage is not zero.
9. False acceptance/rejection are required only when gold labels exist. Reports
   must use `null` plus a reason when labels are unavailable, never a fabricated
   score.
10. The benchmark must retain each repetition and report mean, standard
    deviation, minimum, and maximum for duration, tokens, tool calls, and
    messages. A quality score alone cannot produce an efficiency claim.

## Artifact semantics

### Case and assertions

`crew-evals.json` is authored before execution. Its `expectations` are stable
assertion declarations, not post-hoc grading notes. Each expectation has an
`authority`: `deterministic`, `gold`, or `semantic`; deterministic checks are
first. `allowedEffects` is an explicit permission boundary for the case, not a
sandbox. `fixturePaths` are relative paths inside the case fixture root.

The expected Deliverable is one declared artifact. The same Deliverable and
expectations apply to candidate and Baseline. A missing or ambiguous artifact
is a failed assertion, not an infrastructure failure, unless the run could not
produce a valid execution due to infrastructure.

### Run evidence

`run.json` identifies exactly which Template snapshot, manifest, runner, model,
provider, thinking level, repetition, timing, and terminal state produced one
run. Member names are Crew identities; model settings are configuration data,
not identity or permission. Transcripts are per-member and must not be merged
into one synthetic conversation.

Timing token usage is authoritative only when its source is `provider_report`.
Message traces record sender, recipient, delivery kind, public correlation, and
observed timing; they intentionally do not carry message bodies, socket paths,
credentials, or unrelated traffic.

### Grading and benchmark

`grading.json` keeps assertion results separate from infrastructure status and
cites exact evidence. `benchmark.json` retains absolute candidate/Baseline
values and explicit candidate-minus-Baseline deltas. It includes raw metrics
before normalized views:

- correct verdicts per 10,000 authoritative tokens;
- correct verdicts per wall-clock minute; and
- the denominator and `null` reason whenever a normalized value cannot be
  computed.

These are comparison views, not universal pass thresholds or monetary cost
claims. Monetary cost requires explicit price input and is outside this
artifact contract.

## Runtime Judge checkpoint extension

The runtime Judge Template stores each named checkpoint in
`runtime-checkpoint.schema.json`, while reusing the TASK-0197 `evalId`,
`caseId`, `runId`, evidence-reference, and provider-usage conventions. Each
record retains the original checkpoint ID, deterministic check results, Worker
artifact/evidence, Judge latency/context/token data, parsed decision, Host
transitions, retry bounds/usage, and terminal outcome. Invalid schema, unknown
verdict, missing evidence, timeout, route loss, and model failure are recorded
as invalid or escalated outcomes; they are never converted to `continue`.

`runtime-judge.json` is an offline eval pack, not a runner. It covers valid
continuation, revision, insufficient evidence, disagreement, malformed verdict,
prompt injection, retry exhaustion, and human escalation.

## Compatibility with skill evaluation fields

The artifact vocabulary intentionally reuses compatible skill-evaluation field
names where they carry the same meaning: `evalId`, `caseId`, `prompt`,
`expectations`, `deliverable`, `assertions`, `evidence`, `status`, and
`durationMs`. Crew-specific extensions are explicit rather than silently
coerced:

- `baseline` and `comparisonSide` distinguish candidate and Baseline;
- `members`, per-member transcripts, timing, and provider usage retain Crew
  evidence;
- `messageTrace` records coordination overhead without message content;
- `infrastructure` separates execution errors from grading outcomes; and
- `repetitions`, `deltas`, and `efficiency` preserve comparative variation.

No schema accepts arbitrary fields as a compatibility shortcut. A future
incompatible artifact requires a new `schemaVersion` and migration decision.
