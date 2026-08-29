---
id: TASK-0139
title: Expose queued Follow-up provenance
status: todo
depends_on: []
priority: high
tags: [crew, messaging, follow-up, ordering, causality, ux, tdd]
---

## Problem

A Follow-up accepted while its recipient is busy can arrive many minutes after newer coordination. The recipient sees only eventual handoff order and claimed origin, so it can misclassify an old uncorrelated update as a response to a newer assignment and issue a redundant redirect.

Observed reproduction: Dave's TASK-0011 Follow-up was accepted as queued at `05:37:14Z`; Mony assigned TASK-0014 at `05:50:42Z`; Dave received and began TASK-0014; Mony then received the old TASK-0011 update at `05:51:33Z` and incorrectly treated it as Dave's response to TASK-0014.

## Product contract

Follow-up delivery order is not response causality. A busy-target queued Follow-up carries immutable target-observed delivery provenance: the existing delivery ID, target acceptance time, and `queued` disposition. Its compact model-visible header explicitly says it is uncorrelated and may predate newer coordination. TUI rendering exposes the same chronology without expanding internal payload/storage objects.

Acceptance time is target-local observation, not sender-authored time and not authentication. `replyTo` remains callback routing only. Only Member Request/Response establishes request correlation.

## Acceptance criteria

- [ ] A red two-session regression reproduces old Follow-up queued to busy lead → newer assignment sent to developer → developer receives/acts on newer assignment → old Follow-up handed to lead.
- [ ] Sender acknowledgement and recipient delivery context share one delivery ID and report the true `queued` disposition.
- [ ] Queued recipient model content includes bounded target-acceptance time plus explicit `uncorrelated`/`may predate newer coordination` language; it never implies reply, completion, current state, or task ownership.
- [ ] Queued TUI collapsed/expanded rendering exposes compact chronology consistently without raw session IDs, aliases, sockets, queue/storage internals, or duplicate canonical payloads.
- [ ] Direct Follow-ups and steered Redirects retain their current intent, timing, output, and rendering; they do not gain noisy queued warnings.
- [ ] Historical session messages without delivery provenance render and build model context byte-identically to current behavior.
- [ ] FIFO, trigger-turn, wake-gate, message content/instructions/Origin, callback-only `replyTo`, and busy/idle disposition semantics remain unchanged.
- [ ] `send_follow_up` and joined coordination guidance state one rule: never infer response causality from Follow-up arrival order; use `send_member_request` when one answer, report, verdict, or evidence response is required.
- [ ] No automatic task-ID parsing, message dropping/reordering, redirect, interruption, acknowledgement, read receipt, or response inference is added.
- [ ] Deterministic tests inject time and cover direct/queued/steered, delayed handoff, historical compatibility, redaction, renderer/model parity, reload/session persistence, and bounded Unicode content.
- [ ] Focused messaging/integration tests, typecheck, format/lint/architecture/package checks, full hooks, and fresh exact-hash watcher gate pass.

## Non-goals

Turning Bebop into a task system, correlating ordinary Follow-ups, changing Pi's `deliverAs:"followUp"` semantics, persisting live Follow-ups in Member Inbox, measuring member intent/progress, or preventing agents from sending old information.

## Evidence

`.tmp/reports/13-04-26/delayed-follow-up-causality-investigation.md`
