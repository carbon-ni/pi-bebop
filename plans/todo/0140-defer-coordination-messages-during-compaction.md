---
id: TASK-0140
title: Defer coordination messages during compaction
status: todo
depends_on: []
priority: high
tags: [messaging, compaction, coordination, lifecycle, tdd]
---

# Defer coordination messages during compaction

## Problem

Bebop can submit model-bound coordination messages while recipient Pi is compacting. Compaction is session-maintenance boundary. Delivery during it can break lifecycle ordering and expose message before agent can safely process it.

## Desired outcome

Add one receiver-owned **Compaction Delivery Gate**. System accepts coordination messages into bounded pending delivery while recipient compacts. It hands them to Pi exactly once after compaction ends. Senders do not poll, retry, inspect compaction, or coordinate release.

Compaction delay is delivery scheduling only. It does not change message meaning, mode, correlation, priority, attribution, or authority.

## Scope

Inventory every Bebop-owned path that can enter model context through `pi.sendMessage`. Route all model-bound coordination delivery through same gate, including:

- Follow-up and Redirect;
- inbound Member Request;
- correlated Response/wait-resume model delivery;
- Inbox, Broadcast, external Intake, and Crew-to-Crew handoff;
- Interrupt recovery message;
- Presence or other Bebop notifications that enter model context.

Control effects are separate from model delivery. For example, hard-interrupt abort request can remain best-effort system control, but its recovery message cannot enter model context during compaction.

## Delivery contract

1. Receiver reads live Pi compaction state. Sender identity, Role, tool, message, or Presence never decides state.
2. If recipient is not compacting, preserve current delivery behavior byte-for-byte.
3. If recipient is compacting, system owns message as pending but does **not** call `pi.sendMessage`, trigger provider turn, append model-visible message, wake blocking wait, or mark request visible to responder.
4. Sender receives existing queued/deferred acknowledgement only after system safely owns exact message. Acknowledgement does not mean model delivery, reading, response, or completion.
5. Acknowledged pending message cannot disappear on reload, session replacement, shutdown, or process failure. Persist pending state before acknowledgement, or do not report successful acceptance.
6. `session_compaction_end` is wake signal, not proof. Gate rechecks live state. If compaction remains active or another compaction started, keep queue pending.
7. Drain pending entries once, in receiver acceptance order. Preserve exact content, ordered instructions, Origin, callback/correlation metadata, delivery mode, FIFO semantics, and queued Follow-up provenance.
8. Message accepted before compaction-end boundary stays ahead of message accepted after boundary. Response arrival order or callback timing cannot reorder them.
9. If compaction starts while queue drains, finish only already committed handoff, stop before next entry, and retain remainder.
10. `notifyAcceptedMessage` and Member Request visibility/activation occur at safe handoff, not while compacting. No wait or request timer can pretend agent received deferred model context.
11. Queue is finite and deterministic. Capacity failure rejects newest unowned entry before acknowledgement. It never drops, overwrites, truncates, duplicates, or partially accepts message.
12. Delivery does not infer task state, availability, willingness, acknowledgement, response, or completion.

## Implementation plan

1. Add red tests for direct delivery versus compacting deferral at one pure receiver-owned coordination seam.
2. Add bounded pending-delivery state with explicit ownership, ordering, and terminal cleanup.
3. Inject gate at Pi composition root. Replace direct Bebop-owned model-bound `pi.sendMessage` calls with gate operation; do not duplicate compaction checks per tool/handler.
4. Wire balanced Pi compaction lifecycle. Start marks gate closed; end rechecks state and schedules one drain. Reload/session replacement/shutdown restore or safely retain acknowledged pending work.
5. Keep surface-specific behavior outside gate: Follow-up remains FIFO, Redirect remains steer, Inbox remains durable, Request remains correlated, and Interrupt remains best-effort control plus deferred recovery message.
6. Preserve immutable queue chronology. Compaction time contributes to acceptance-to-handoff delay once and does not continuously age after handoff.
7. Update Ubiquitous Language, architecture, and messaging workflow with Compaction Delivery Gate boundary and acknowledgement meaning.

## Acceptance criteria

- [ ] TDD starts with failing direct and compacting paths before gate implementation.
- [ ] During active manual, automatic, or nested compaction, zero deferred coordination messages call `pi.sendMessage`, trigger model/provider work, enter model context, wake blocking waits, or activate responder-visible Request handling.
- [ ] First safe compaction-end recheck drains each pending message exactly once; false/stale end events drain nothing.
- [ ] Mixed Follow-up, Redirect, Request, Response resume, Inbox/Broadcast/Intake/Crew letter, Interrupt recovery, and model-bound notification fixtures retain exact payload, metadata, mode, correlation, and deterministic acceptance order.
- [ ] Message accepted at same boundary as compaction end has one owner and one handoff. Deterministic race tests cover accept-before-end, end-before-accept, nested start/end, and new compaction during drain.
- [ ] Messages accepted after compaction cannot overtake deferred messages accepted earlier.
- [ ] Queued Follow-up provenance reports immutable receiver-observed acceptance-to-handoff delay including compaction wait, without claiming correlation.
- [ ] Sender acknowledgement distinguishes safe system acceptance from model handoff and makes no delivery/read/response/completion claim.
- [ ] Reload, resume, fork, session replacement, shutdown, socket loss, thrown renderer/provider boundary, and process restart cannot lose an acknowledged pending message or hand it off twice.
- [ ] Capacity is bounded. Overflow and malformed entry fail atomically before acknowledgement without affecting existing FIFO entries.
- [ ] Compaction state and pending queue expose no message content, instructions, Origin, correlation route, session ID, socket/path, model data, or inferred intent through Member Status, wait-state, Presence, or Crew output.
- [ ] Existing non-compacting delivery remains byte-compatible and existing Follow-up/Redirect/Request/Inbox/Interrupt tests remain green.
- [ ] Real Pi host test proves message received during compaction is absent from model/provider context until compaction ends, then appears once in correct order.
- [ ] Focused tests, typecheck, formatting, architecture/package checks, coverage/risk gate, full hooks, and fresh watcher pass with unchanged-worktree proof.

## Non-goals

- Sender-side compaction polling or retry loops.
- Pausing, aborting, extending, or restarting compaction to deliver message.
- Changing Follow-up, Redirect, Request/Response, Inbox, Interrupt, or Crew authority semantics.
- Treating compaction end as task completion, availability, acknowledgement, or response.
- General-purpose scheduler, durable chat history, message dashboard, or productivity monitoring.

## Notes

This plan is independent but touches shared Pi composition and lifecycle files. Finish current TASK-0121 ownership and exact-hash acceptance before assigning implementation to avoid mixing concurrent work.
