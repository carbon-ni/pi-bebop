---
id: TASK-0088
title: Make user-facing errors actionable
status: doing
depends_on: []
priority: high
tags: [errors, ux, cli, tools, configuration, tdd]
---

# Make user-facing errors actionable

## Problem
User-facing failures often state only a technical symptom. Users need every pi-bebop-owned error to explain what failed, where the problem is, and what they can do next.

## Context

The Intake failure is one example:

```text
Crew startup role join failed: intake contact is not a configured member: product
```

It says why validation stopped, but not that the source is Crew configuration, where that configuration lives, which field is invalid, or how to correct it.

Apply one error contract to pi-bebop-owned user-facing surfaces: startup, CLI commands, Pi commands, registered tools, Crew membership, Intake, Inbox, configuration, and filesystem operations.

An actionable error answers, when the information is known:

1. **What failed?** Name the user operation, not only an internal component.
2. **Where?** Name relevant command, safe path, field, member, or input.
3. **Why?** State rejected condition and value without exposing secrets.
4. **What next?** Give one or more concrete corrective actions.

## Product contract

Normative source: `docs/ACTIONABLE-ERRORS.md`.

The v1 inventory is frozen at source commit `64bd150` and contains:

- 12 standalone CLI registry leaves (11 explicit commands plus home), the shared usage/operational renderer, and the executable fallback;
- 12 registered Pi agent tools;
- one `/crew` family with nine top-level actions;
- Pi session-start/startup-send adapters and extension lifecycle failure fallback;
- every configuration/storage/transport error only where one of those public adapters renders it.

Completion is boundary-based rather than a changing count of error strings. Every frozen public adapter must use the shared presenter or have a reviewed external-owner exemption. A source/AST guard makes later direct error rendering fail the gate.

## Implementation plan

1. Add red contract tests for the frozen inventory and direct-render guard.
2. Implement one pure format-independent Actionable Error presentation constructor over closed safe descriptors; do not accept arbitrary `Error`.
3. Map domain/application/infra codes at public adapters while retaining structured errors internally.
4. Render the same semantic error through CLI text/TOON/JSON, tool content/details, and Pi TUI/headless fallback.
5. Migrate the frozen CLI, tool, `/crew`, startup, and lifecycle boundaries in bounded slices with happy/unhappy tests.
6. Run redaction/safe-location/unknown-error adversarial matrices and prove success bytes/exit/domain behavior unchanged.

## Acceptance criteria

### Product definition

- [x] `docs/ACTIONABLE-ERRORS.md` defines Actionable Error, a finite baseline inventory, inclusion/exclusion rules, future-growth guard, and authoritative surface counts/names.
- [x] The contract fixes a closed shared model: stable code, public operation, canonical message, optional safe location, 1–3 recovery actions, and bounded valid choices/truncation metadata, with NFC/control/UTF-8 limits for every string.
- [x] Text grammar and additive CLI JSON/TOON/tool envelopes are exact; fixed-order accounting, overflow priority, per-envelope limits, and `--full` error invariance preserve one semantic JSON/TOON object and current status/exit/compatibility fields.
- [x] Safe-location, per-field omit/redact/fallback policy, forbidden sources, exact sensitive-pattern order/grammar, marker-spoof behavior, unknown-cause, and evidence-collection rules are explicit.
- [x] `UL.md` defines Actionable Error and distinguishes it from domain errors, raw exceptions, and unsafe paths.

### Runtime implementation

- [ ] Every frozen Pi Bebop-owned user error uses the shared presentation or a reviewed external-owner exemption; a deterministic guard rejects a newly registered direct render.
- [ ] Every presentation names the public failed operation, states a safe factual reason, includes a safe actionable location when known, and gives recovery/evidence guidance without promising success.
- [ ] Known domain/application codes are preserved. Unknown causes use `unexpected-failure`, never fabricated `offline`, timeout, permission, malformed, or retryability semantics.
- [ ] Constrained valid values preserve authoritative order and exact 0/1/32/33-entry bounds; unsafe/overflow choices are omitted with honest truncation metadata and discovery guidance.
- [ ] CLI text/TOON/JSON have semantic parity; expected errors stay on stdout, exit `2` for usage and `1` for operational failure, and structured output retains safe `target`, code, operation, message, recovery, and details.
- [ ] Every tool error retains `isError:true` and `details.error`, adds full `details.actionableError`, and makes tool content byte-identical to its canonical message.
- [ ] Pi command/startup/lifecycle errors use the same sanitized message through TUI/headless fallback and never trigger a provider/model turn merely to explain a failure.
- [ ] Errors never expose raw messages/instructions/prompts, credentials/secrets, reply routes, session IDs/aliases, sockets, operation IDs, cursors unless safely explicit, temp/lock/quarantine names, stacks/causes, dependency output, expanded home, unsafe absolute paths, or unbounded input.
- [ ] Tests cover every frozen adapter family plus startup, configuration, Membership, filesystem, transport, timeout/abort, conflict/capacity, protocol/version, partial failure, and unknown cause using real public boundaries—not prose/keyword checks alone.
- [ ] Existing success output, help, failure status/exit, domain semantics, delivery/persistence meaning, resource cleanup, and deterministic ordering remain unchanged except the specified additive error presentation.
- [ ] Focused coverage, typecheck, formatting, lint, architecture/package checks, full hooks, and a fresh unchanged-worktree watcher gate pass.

## Accepted bounded slice evidence

- Pi startup/lifecycle slice: `f41735e`, `274f23e`, `c045ac0`, and `e85cc0e`/`b5b84fb` cover the six current direct-render findings in `session-start.ts`, `startup-send.ts`, and `extension.ts`.
- Crew Init CLI slice: `b116eb1` removes raw catch interpolation and `9bc871f` proves real text/JSON/TOON/`--full` runner parity, stdout-only errors, safe redaction, and the guard ratchet.
- Send CLI slice: `a453c13` maps the handler boundary to safe actionable errors; `9c64db1` and `9f3f6e0` prove Intake and direct-socket public runner parity across text/JSON/TOON and default/`--full` modes.
- `get_member_status` tool baseline slice: `399273a` removes exactly one stale allowance; source/tests are unchanged and a disposable reintroduced-direct-render copy fails the guard.
- `send_to_inbox` tool baseline slice: `681e4d6` removes exactly one stale allowance; source/tests and all other entries are unchanged, with disposable reintroduced-render guard failure proof.
- `interrupt_member` tool baseline slice: `ab88bcf` removes exactly one stale allowance; source/tests/application/RPC/success behavior and other entries are unchanged, with disposable reintroduced-render guard failure proof.
- Member Request tools baseline slice: `68909bc` removes exactly one stale allowance; all three request surfaces and source/tests/application/wait/correlation remain unchanged, with disposable reintroduced-render guard failure proof.
- Member Intent tools slice: `d6a3939`/`ff595e1` preserve typed offline/rejection, map aborts to `aborted`, and map unknown raw dependency failures to `unexpected-failure`; exactly one adapter allowance was removed.
- Crew Board tool baseline slice: `ce1a726` removes exactly its stale tool-result allowance; source/tests/output behavior are untouched and a disposable reintroduced-render copy fails the guard.
- `wait_for_member_idle` tool baseline slice: `eeb9851` removes exactly its stale tool-result allowance; source/tests/docs are untouched and a disposable reintroduced-render copy fails the guard.
- `broadcast_to_crew` tool baseline slice: `ae0c493` removes exactly its count-3 tool-result allowance; source/tests/app/Inbox/schema/output/docs are untouched and a disposable reintroduced-render copy fails the guard.
- Exact-hash QA: startup/lifecycle PASS at `b5b84fb` (focused `36/36`, watcher gen282, full `1,460/1,460`); Crew Init PASS at `9bc871f` (focused `62/62`, watcher gen294, full `1,461/1,461`); Send PASS at `9f3f6e0` (watcher gen307, full `1,463/1,463`); get_member_status PASS at `399273a` (guard 13, watcher gen310); send_to_inbox PASS at `681e4d6` (guard 13, watcher gen314); interrupt_member PASS at `ab88bcf` (guard 13, watcher gen318); Member Request PASS at `68909bc` (guard 13, watcher gen322); Member Intent PASS at `ff595e1` (watcher gen351); Crew Board PASS at `ce1a726` (guard 13, watcher gen354); wait_for_member_idle PASS at `eeb9851` (guard 13, watcher gen378); broadcast_to_crew PASS at `ae0c493` (guard 13, watcher gen382). Reports: `.tmp/reports/13-04-26/task-0088-b5b84fb-final-qa.md`, `.tmp/reports/13-04-26/task-0088-9bc871f-final-qa.md`, `.tmp/reports/13-04-26/task-0088-9f3f6e0-final-qa.md`, `.tmp/reports/13-04-26/task-0088-399273a-final-qa.md`, `.tmp/reports/13-04-26/task-0088-681e4d6-final-qa.md`, `.tmp/reports/13-04-26/task-0088-ab88bcf-final-qa.md`, `.tmp/reports/13-04-26/task-0088-68909bc-final-qa.md`, `.tmp/reports/13-04-26/task-0088-ff595e1-final-qa.md`, `.tmp/reports/13-04-26/task-0088-ce1a726-final-qa.md`, `.tmp/reports/13-04-26/task-0088-eeb9851-member-idle-baseline-qa.md`, `.tmp/reports/13-04-26/task-0088-ae0c493-final-qa.md`.
- These bounded slices are accepted, but TASK-0088 remains `doing`: the remaining frozen CLI, registered-tool, `/crew`, and adapter inventory still requires separate implementation and verification.

## Product evidence

- Normative contract: `docs/ACTIONABLE-ERRORS.md`.
- Canonical language: `UL.md` (`Actionable Error` and ambiguity boundaries).
- Inventory/refinement report: `.tmp/reports/27-08-26/task-0088-actionable-error-product-contract.md`.
- Baseline discovery: registry/tool/Pi boundary AST and literal scans at `64bd150`; implementation has not been claimed.

## Non-goals

- Rewriting errors owned entirely by Pi, Node.js, the operating system, or external dependencies when pi-bebop has no meaningful context.
- Guessing a corrective action when cause is unknown.
- Silently correcting invalid input or configuration.
- Combining unrelated failure causes into one generic message.

## Notes

TASK-0087 is the first concrete example and should conform to this contract without waiting for a full repository-wide migration.

