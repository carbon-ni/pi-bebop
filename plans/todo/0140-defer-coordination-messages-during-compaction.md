---
id: TASK-0140
title: Defer coordination messages during compaction
status: todo
depends_on: [TASK-0143]
priority: high
tags: [messaging, compaction, coordination, lifecycle, tdd]
---

# Defer coordination messages during compaction

## Problem

Bebop can submit model-bound coordination messages while recipient Pi is compacting. Compaction is session-maintenance boundary. Delivery during it can break lifecycle ordering and expose message before agent can safely process it.

## Desired outcome

Add one receiver-owned **Compaction Delivery Gate**. System accepts coordination messages into bounded pending delivery while recipient compacts. After compaction, it hands them to Pi once during normal operation and uses an explicit at-least-once recovery contract after an ambiguous process crash. Senders do not poll, retry, inspect compaction, or coordinate release.

Compaction delay is delivery scheduling only. It does not change message meaning, mode, correlation, priority, attribution, or authority.

## Scope

One composition-root gate owns every Bebop path that can enter model context through `pi.sendMessage`, including:

- Follow-up and Redirect;
- inbound Member Request and its first-idle reminder;
- correlated Response/wait-resume model delivery;
- Inbox, Broadcast, external Intake, and Crew-to-Crew handoff;
- Interrupt recovery message;
- model-bound Presence notifications;
- startup or control responses that enter model context, even when they do not trigger a turn.

Control effects are separate from model delivery. A hard-interrupt abort request remains best-effort system control, but its recovery message cannot enter model context during compaction.

Add a source ratchet: no Bebop-owned direct `pi.sendMessage` call may remain outside the gate adapter.

## Delivery contract

1. Receiver derives compaction state only from canonical Pi lifecycle events. Sender identity, Role, tool, message, or Presence never decides state.
2. If recipient is not compacting and no older pending entry exists, preserve current delivery behavior byte-for-byte.
3. If recipient is compacting or an older entry is pending, system owns the message in a receiver journal but does **not** call `pi.sendMessage`, trigger provider work, append a model-visible message, wake a blocking wait, remove an Inbox item, or make a Request visible.
4. Persist the exact canonical envelope atomically before acknowledging deferred ownership. The deferred acknowledgement is exactly: `Accepted by the recipient system for queued delivery. This does not mean model delivery, reading, availability, completion, or response.` It never reveals compaction. Non-compacting acknowledgements remain byte-identical.
5. An acknowledged pending message cannot disappear on reload, resume, fork, session replacement, leave, shutdown, socket loss, or process failure.
6. Pi 0.84.3 `session_before_compact` closes the gate. `session_compact` and `session_compact_failed` are terminal wake signals. There is no `session_compaction_start` or `session_compaction_end` extension event.
7. Terminal handlers never drain synchronously. They schedule one injected `setImmediate`-class post-event task. The task drains only when local compaction depth is zero and the captured lifecycle generation is still current.
8. Drain pending entries once during uninterrupted operation, in persisted receiver acceptance order. Preserve the immutable canonical envelope, ordered instructions, Origin, callback/correlation metadata, delivery mode, FIFO semantics, and queued Follow-up provenance. An ambiguous crash recovery derives one handoff with the separate exact replay provenance locked by TASK-0143.
9. A message accepted before a terminal boundary stays ahead of one accepted after it. New direct delivery cannot overtake an existing backlog.
10. If compaction starts while the queue drains, finish only the already committed handoff, stop before the next entry, and retain the remainder.
11. `notifyAcceptedMessage`, Inbox removal, Member Request registration/visibility, and Request timers occur only at safe handoff.
12. Queue capacity is deterministic: at most 64 pending entries, at most 1,100,000 UTF-8 bytes per canonical persisted envelope, and at most 70,400,000 aggregate canonical bytes. Reject the newest entry atomically before acknowledgement if any limit fails.
13. Delivery does not infer task state, availability, willingness, acknowledgement, response, or completion.

## Locked ownership and lifecycle boundaries

### Receiver-owned journal

The source of truth is an external journal under the trusted Crew store, not a session entry. Its ownership key is the canonical Crew Manifest path plus the exact Member name, encoded as a safe hash. Role, session ID, and socket path are not ownership.

Each record has a stable receiver-assigned delivery ID, monotonic acceptance sequence, immutable canonical envelope bytes, state `pending`, `handing-off`, or `replay-blocked`, and `replayAttempts: 0 | 1`. Persist with atomic replacement before deferred acknowledgement. Session entries may provide delivery evidence but are never the pending store.

A restarted `pending` record resumes its first handoff without possible-duplicate provenance. For a new handoff, atomically persist `handing-off` with `replayAttempts: 0`, embed the delivery ID in internal details, then call Pi. Mark delivered only after Pi session evidence contains that ID.

After a process crash, evidence present means do not replay. For evidence-absent `handing-off` with `replayAttempts: 0`, atomically persist `replayAttempts: 1`, then invoke at most one automatic replay with the same delivery ID. Keep the canonical envelope immutable. The cloned Pi handoff gets exact content prefix `[replayed after ambiguous restart; possible duplicate]\n\n` and closed details `{ deliveryReplay: { kind: "ambiguous-restart", possibleDuplicate: true } }`. This 56-byte ASCII prefix and the derived details are not canonical-envelope capacity bytes and expose no ID.

On every later startup, evidence-present `handing-off` completes regardless of the counter. Evidence-absent `handing-off` with `replayAttempts: 1` atomically becomes `replay-blocked` before any delivery work and never calls Pi. This deterministic rule covers a crash after counter persistence but before or during replay: the reserved attempt is consumed because Pi 0.84.3 evidence cannot distinguish those points. Retain the record at the FIFO head and emit one bounded local actionable error outside model context and all Crew-visible status surfaces.

Graceful reload, resume, fork, replacement, leave, and shutdown close acceptance and finish reconciliation before relinquishing the receiver. They retain `pending` for the same Manifest/Member, complete evidence-present `handing-off`, and atomically block evidence-absent `handing-off` without replay. If that lifecycle is interrupted before reconciliation finishes, startup treats it as a process crash. A removed or changed Member identity remains blocked and is never reassigned to another Member. Real-host crash-point tests must prove no acknowledged record is discarded and at most one automatic replay invocation occurs.

### Deferred Member Request

The current Request response channel is a live socket, not a durable callback route. Therefore a deferred Member Request stays unacknowledged, unregistered, invisible, and timer-free until safe handoff. Keep its channel open while pending. At handoff, verify the channel is live, register and expose the Request, call `notifyAcceptedMessage`, acknowledge it, and start existing timers.

If the channel closes or the process fails before acknowledgement, delete the unacknowledged pending record and never activate it after restart. The requester receives the existing offline/timeout outcome. Adding a durable Request reply route is out of scope.

### Safe post-compaction seam

Pi 0.84.3 emits extension terminal handlers before its internal compaction cleanup finishes and exposes no public `ExtensionContext.isCompacting()`. The accepted seam is event-derived depth plus generation and a post-event macrotask:

- `session_before_compact`: increment depth and generation synchronously;
- `session_compact` or `session_compact_failed`: decrement one matching depth and schedule a post-event check;
- unmatched or stale terminal: no drain;
- post-event check: drain only at depth zero with unchanged generation;
- a new start before or during drain closes the gate synchronously.

This seam is accepted only with a real Pi 0.84.3 host test proving the post-event task runs after compaction provider work, normal operation hands off once, and ambiguous restart follows the explicit at-least-once replay contract.

## Feasibility freeze

Production implementation is frozen at code baseline `a696ff7` until the three feasibility rows below have one clean exact-hash evidence report and independent QA verdict. Evidence tests, host fixtures, source ratchets, and reports may change; product delivery logic may not expand during the freeze.

If **F2** fails because Pi 0.84.3 cannot expose durable typed handoff evidence before provider execution, stop TASK-0140 implementation. Upstream Pi code changes are not allowed in TASK-0140. Product must revise the guarantee or extension architecture using Pi 0.84.3's existing public API; otherwise mark TASK-0140 blocked. Do not approximate the guarantee with timing, in-memory state, or green unit tests.

| ID | Invariant | Required evidence | Owner | Pass rule |
| --- | --- | --- | --- | --- |
| F1 | Receiver persists exact envelope before deferred acknowledgement | Deterministic persistence-delay/failure fixture across every acknowledging surface | Dave; Kelly verifies | No success or wake before awaited durable append; failure returns bounded error and owns nothing |
| F2 | Pi provides durable typed handoff evidence before provider/model consumption | Real Pi 0.84.3 `AgentSessionRuntime` process-restart fixture with stable delivery ID and provider capture | Dave; Kelly verifies | Restart finds exact session evidence and reconciles `handing-off` without loss or replay; provider sees one delivery |
| F3 | Every Bebop model-bound path crosses one gate | Mechanical source ratchet plus surface inventory for Follow-up, Redirect, Request/reminder, Response resume, Inbox/Broadcast/Intake/Crew, Interrupt recovery, Presence, and startup/control | Dave; Kelly verifies | No direct `pi.sendMessage` remains outside the sole adapter and each surface has one routing fixture |

Mony owns the freeze. Any production edit invalidates the feasibility candidate. Mary issues the Product feasibility verdict only from Kelly's explicit verdict on the same clean full SHA and fresh watcher fingerprint.

### Feasibility verdict

Exact clean evidence commit `1c91fdaead3298e9d72ccc1caf98997ddaba7628`: **F1 PASS, F2 BLOCK, F3 PASS**. Kelly independently confirmed watcher gen1143 fingerprint `35875274d1a7` PASS and the F2 public-API limitation. Pi 0.84.3 exposes no durable flush acknowledgement between typed session handoff and provider consumption; the host fixture proves ordering only.

Production implementation is stopped. TASK-0140 now depends on TASK-0143 selecting an honest extension-only crash-window guarantee. No code change, green test, or timing assumption may override this Product BLOCK.

## Risk-ranked acceptance matrix

After F1–F3 pass, implementation resumes against this bounded matrix. Rows identify the remaining directly affected dependency boundary; process artifacts never replace required host evidence.

| ID | Risk boundary | Exact evidence target | Owner |
| --- | --- | --- | --- |
| R1 | Ack and compatibility | Exact text/bytes, code, visibility, disposition, turn/no-turn, plus unchanged non-compacting regression | Mary + Dave |
| R2 | Lifecycle identity | Tagged generation tests and real-host success, failed/aborted, nested, stale-terminal, and new-start-during-drain cases | Dave + Kelly |
| R3 | Durable recovery | Crash points before/after append, ack, `handing-off`, Pi evidence, completion; restart/reload/resume/fork/replacement isolation | Dave + Kelly |
| R4 | Surface semantics | Request activation/channel loss, Inbox removal, Interrupt completion, Follow-up provenance, Response resume, Presence, startup/control | Dave + Kelly |
| R5 | Concurrency and order | Cross-process ID reservation, reconfiguration barrier, global FIFO, no later direct overtake | Dave + Kelly |
| R6 | Capacity and privacy | Exact 64/1,100,000/70,400,000 boundaries and no gate/journal metadata leakage | Kelly |
| R7 | Frozen final verdict | Full SHA, clean fingerprint, matrix delta, focused/full/host commands, fresh watcher, residual gaps | Mony + Kelly + Mary |

## Implementation plan

1. Add red tests for direct delivery, compacting deferral, capacity, persistence, and crash points at one pure receiver-owned seam.
2. Add the bounded external journal with stable delivery IDs, acceptance sequence, `pending`/`handing-off`/`replay-blocked` reconciliation, `replayAttempts: 0 | 1`, and injected atomic storage operations.
3. Inject the gate at the Pi composition root. Replace every Bebop-owned model-bound `pi.sendMessage` call with the gate; mechanically reject new direct calls.
4. Wire `session_before_compact`, `session_compact`, and `session_compact_failed` to the locked depth/generation/post-event seam. Remove the historical unsupported event name.
5. Keep surface-specific behavior outside the gate: Follow-up stays FIFO, Redirect stays steer, Inbox stays durable until handoff, Request stays live-channel correlated, and Interrupt stays best-effort control plus gated recovery.
6. Reconcile the journal on reload, resume, fork, replacement, leave, shutdown, and restart before accepting new handoff work.
7. Preserve immutable chronology. Compaction time contributes to acceptance-to-handoff delay once and does not continuously age after handoff.
8. Update Ubiquitous Language, architecture, and messaging workflow with the gate, journal, lifecycle seam, capacity, and acknowledgement meaning.

## Acceptance criteria

- [ ] TDD starts with failing direct, compacting, persistence, overflow, crash-point, and lifecycle-race paths.
- [ ] A source ratchet inventories every Bebop-owned model-bound path and rejects direct `pi.sendMessage` outside the gate adapter.
- [ ] During active manual, automatic, failed, aborted, or synthetic nested compaction, zero deferred coordination messages call `pi.sendMessage`, trigger coordination provider work, enter model context, wake waits, remove Inbox items, or activate Request handling.
- [ ] `session_before_compact` closes synchronously; `session_compact` and `session_compact_failed` only schedule the post-event check. Unsupported lifecycle names are absent.
- [ ] The first safe depth-zero/current-generation post-event check drains each pending message once during uninterrupted operation; unmatched, false, or stale terminals drain nothing. Only an evidence-absent ambiguous restart may replay.
- [ ] Deterministic races cover accept-before-terminal, terminal-before-accept, nested start/terminal, new start before the post-event task, and new start during drain.
- [ ] Mixed Follow-up, Redirect, Request, Request reminder, Response resume, Inbox/Broadcast/Intake/Crew letter, Interrupt recovery, Presence, and control-response fixtures retain the exact canonical payload, metadata, mode, correlation, and acceptance order. Normal and restarted-`pending` handoffs are byte-exact. Only the intentional ambiguous replay clone adds the exact prefix and closed replay details; removing those additions yields the byte-exact canonical envelope.
- [ ] A later direct message cannot overtake older pending work. One acceptance sequence governs all surfaces.
- [ ] Deferred Member Request remains unacknowledged and invisible until handoff; channel loss before handoff never creates a responder-visible orphan.
- [ ] Queued Follow-up provenance reports immutable receiver-observed acceptance-to-handoff delay including compaction wait, without claiming correlation.
- [ ] Deferred acknowledgement is byte-exact, follows durable ownership, reveals no compaction state, and makes no delivery/read/availability/response/completion claim. Non-compacting acknowledgement is byte-compatible.
- [ ] Graceful reload, resume, fork, replacement, leave, and shutdown close acceptance and finish reconciliation before relinquishing the receiver: retain `pending`, complete evidence-present `handing-off`, and block evidence-absent `handing-off` without replay. An interrupted lifecycle uses process-crash recovery. Socket loss and thrown renderer/provider boundaries cannot discard an acknowledged record.
- [ ] Process restart resumes `pending` as a first handoff without replay provenance; it reserves and invokes at most one automatic replay only for evidence-absent `handing-off` with `replayAttempts: 0`; any later evidence-absent `handing-off` with `replayAttempts: 1` becomes retained `replay-blocked` before delivery work and without another Pi call.
- [ ] Crash tests cover before persistence, after persistence/before ack, `pending` restart, after ack, after `handing-off`/before Pi send, the ambiguous Pi-send/evidence window, after Pi session evidence/before journal completion, atomic `replayAttempts` persistence, crash after replay reservation but before invocation, crash during replay, evidence present after replay, and evidence absent with attempts 1 becoming `replay-blocked`.
- [ ] Capacity tests enforce 64 entries, 1,100,000 bytes per canonical envelope, and 70,400,000 aggregate bytes. Overflow and malformed records fail atomically before acknowledgement without changing existing FIFO state.
- [ ] Gate state and journal expose no compaction state, count, content, delivery ID, instructions, Origin, correlation route, session ID, socket/path, model data, or inferred intent through Member Status, wait-state, Presence, Crew output, or capacity errors. Model-visible replay provenance reveals only ambiguous-restart and possible-duplicate meaning.
- [ ] Existing normal, non-replay Follow-up, Redirect, Request, Inbox, Interrupt, Presence, and startup/control behavior remains byte-compatible. The intentional ambiguous replay clone is tested only against the separate exact-prefix/details rule above.
- [ ] Real Pi 0.84.3 `AgentSessionRuntime` tests cover manual success, automatic compaction, failed/aborted terminals, provider-context exclusion, exact post-event ordering, Request inactivity, distinct modes, one normal handoff, and bounded ambiguous-restart replay.
- [ ] Focused tests, typecheck, formatting, architecture/package checks, coverage/risk gate, full hooks, and fresh watcher pass with unchanged-worktree proof.

## Non-goals

- Sender-side compaction polling or retry loops.
- Pausing, aborting, extending, or restarting compaction to deliver message.
- Changing Follow-up, Redirect, Request/Response, Inbox, Interrupt, or Crew authority semantics.
- Treating compaction end as task completion, availability, acknowledgement, or response.
- General-purpose scheduler, durable chat history, message dashboard, or productivity monitoring.
- Any modification, fork, patch, or unpublished dependency change to upstream Pi.

## Resume gate

TASK-0121 remains closed. TASK-0140 is Product-blocked on TASK-0143. Resume only after the revised crash-window guarantee is copied into this plan, explicitly accepted by Product, independently reviewed by QA, and assigned by the Lead. Retain one implementation owner and exact-hash QA through closure.

## Notes

This task touches the Pi composition root, messaging acknowledgement timing, Request activation, Inbox ownership, lifecycle events, and durable storage. The evidence-only source ratchet remains useful. F2 disproved the original crash-safe exactly-once claim; TASK-0143 replaces it with an honest at-least-once ambiguous-restart contract.
