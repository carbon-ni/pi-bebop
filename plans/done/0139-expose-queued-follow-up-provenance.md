---
id: TASK-0139
title: Expose queued Follow-up provenance
status: done
depends_on: []
priority: high
tags: [crew, messaging, follow-up, ordering, causality, ux, tdd]
---

## Problem

A Follow-up accepted while its recipient is busy can arrive many minutes after newer coordination. The recipient sees only eventual handoff order and claimed origin, so it can misclassify an old uncorrelated update as a response to a newer assignment and issue a redundant redirect.

Observed reproduction: Dave's TASK-0011 Follow-up was accepted as queued at `05:37:14Z`; Mony assigned TASK-0014 at `05:50:42Z`; Dave received and began TASK-0014; Mony then received the old TASK-0011 update at `05:51:33Z` and incorrectly treated it as Dave's response to TASK-0014.

## Product contract

Follow-up delivery order is not response causality. A busy-target queued Follow-up carries immutable target-observed delivery provenance: the existing delivery ID, target acceptance time, handoff time, and `queued` disposition. Default model/TUI output presents the useful relative queue delay instead of raw timestamps:

```text
[follow-up · queued 14m before delivery · uncorrelated]
```

The delay is computed once from target acceptance to target handoff, uses compact deterministic units (`s`, `m`, `h`, `d`), and never changes on rerender or reload. It explicitly says the Follow-up may predate newer coordination. Exact timestamps remain structured provenance for audit, not default output.

Acceptance and handoff times are target-local observations, not sender-authored time and not authentication. `replyTo` remains callback routing only. Only Member Request/Response establishes request correlation.

## Acceptance criteria

- [x] A red two-session regression reproduces old Follow-up queued to busy lead → newer assignment sent to developer → developer receives/acts on newer assignment → old Follow-up handed to lead.
- [x] Sender acknowledgement and recipient delivery context share one delivery ID and report the true `queued` disposition.
- [x] Queued recipient model content includes one compact immutable `<duration> before delivery` label plus explicit `uncorrelated`/`may predate newer coordination` language; it never implies reply, completion, current state, or task ownership.
- [x] Queue-delay formatting is deterministic at boundary values from seconds through days, never negative, never continuously aging, and uses target acceptance/handoff—not sender clock or eventual read time.
- [x] Queued TUI collapsed/expanded rendering exposes the same compact delay consistently; exact timestamps remain structured-only, with no raw session IDs, aliases, sockets, queue/storage internals, or duplicate canonical payloads.
- [x] Direct Follow-ups and steered Redirects retain their current intent, timing, output, and rendering; they do not gain noisy queued warnings.
- [x] Historical session messages without delivery provenance render and build model context byte-identically to current behavior.
- [x] FIFO, trigger-turn, wake-gate, message content/instructions/Origin, callback-only `replyTo`, and busy/idle disposition semantics remain unchanged.
- [x] `send_follow_up` and joined coordination guidance state one rule: never infer response causality from Follow-up arrival order; use `send_member_request` when one answer, report, verdict, or evidence response is required.
- [x] No automatic task-ID parsing, message dropping/reordering, redirect, interruption, acknowledgement, read receipt, or response inference is added.
- [x] Deterministic tests inject time and cover direct/queued/steered, delayed handoff, historical compatibility, redaction, renderer/model parity, reload/session persistence, and bounded Unicode content.
- [x] Focused messaging/integration tests, typecheck, format/lint/architecture/package checks, full hooks, and fresh exact-hash watcher gate pass.

## Non-goals

Turning Bebop into a task system, correlating ordinary Follow-ups, changing Pi's `deliverAs:"followUp"` semantics, persisting live Follow-ups in Member Inbox, measuring member intent/progress, or preventing agents from sending old information.

## Evidence

- Red-first contract: `70914d6`; implementation: `59f9417`.
- Strict provenance fix: `eb65b7d` (red) and `0e4a9ae` (green).
- Exact-hash QA PASS at `0e4a9ae`: focused `56/56`, full `1,485/1,485`, watcher generation 505, fingerprint `533ff487a4ed`. Report: `.tmp/reports/13-04-26/task-0139-0e4a9ae-exact-hash-qa.md`.
- Investigation: `.tmp/reports/13-04-26/delayed-follow-up-causality-investigation.md`
