---
id: TASK-0143
title: Redesign compaction delivery guarantee within Pi public APIs
status: done
depends_on: []
priority: high
tags: [messaging, compaction, product, feasibility, determinism]
---

# Redesign compaction delivery guarantee within Pi public APIs

## Problem
TASK-0140 feasibility proved that Pi 0.84.3 public APIs do not acknowledge durable typed session handoff before provider consumption. With upstream Pi changes prohibited, the current crash-safe exactly-once contract cannot be honestly implemented. Product must choose an explicit extension-only loss/duplicate tradeoff before delivery work resumes.

## Context

Exact feasibility commit `1c91fdaead3298e9d72ccc1caf98997ddaba7628` passed F1 persistence-before-ack and F3 sole-gate ratchet, but independently blocked F2. Pi 0.84.3 public `AgentSession.sendCustomMessage(): Promise<void>` and `SessionManager.appendCustomMessageEntry(): string` expose no stable-storage flush acknowledgement. The real-host fixture proves in-process ordering only; it cannot prove that a crash between Pi handoff and durable session evidence causes neither loss nor replay.

The unavoidable extension-only choice is explicit:

- **at-least-once across an ambiguous crash window:** acknowledged journal work is retained and replayed, so loss is avoided but duplicate model delivery is possible;
- **at-most-once across that window:** mark complete before unproven Pi durability, so duplicates are avoided but acknowledged delivery can be lost;
- **block durable crash recovery:** keep exactly-once only for in-process operation and reject or retain ambiguous records for explicit recovery rather than automatic handoff.

## Locked Product decision

Product selected **at-least-once across the ambiguous crash window**. Acknowledged journal work must not be silently discarded. A process crash may cause at most one automatic replay invocation with the same stable delivery ID when durable Pi session evidence is absent, even if Pi had consumed the first handoff before crashing. Persisting the replay reservation consumes that automatic attempt; a further evidence-absent restart retains and blocks the record for a future explicit operator outcome. Such a replay is a possible duplicate, not a new message or a new acceptance.

The bounded contract is:

1. **Before durable journal append:** no acknowledgement, no ownership, and no later handoff.
2. **`pending` after append and before Pi handoff:** restart resumes the first handoff in original sequence. This is not a possible duplicate and gets no replay provenance.
3. **`handing-off` with durable typed Pi evidence present:** complete the journal record and never replay.
4. **`handing-off` with evidence absent and `replayAttempts: 0`:** treat the window as ambiguous. Atomically persist `replayAttempts: 1` before at most one automatic replay invocation with the same delivery ID and immutable canonical envelope.
5. **Persisted replay reservation reconciliation:** on every later startup, evidence-present `handing-off` completes regardless of the counter. Evidence-absent `handing-off` with `replayAttempts: 1` atomically becomes `replay-blocked` before any delivery work. Do not call Pi. This rule includes a crash after counter persistence but before or during the replay invocation; public evidence cannot distinguish those points, so the reserved attempt is consumed.
6. **Blocked outcome:** retain `replay-blocked`, block later FIFO handoff, and emit one bounded local actionable error. Do not put the error in model context, Presence, Member Status, wait-state, or Crew output. Explicit operator recovery is a future surface, not an automatic retry in TASK-0140.
7. **Journal schema:** each record has state `pending`, `handing-off`, or `replay-blocked`, plus `replayAttempts: 0 | 1`. The canonical envelope stays byte-immutable. State and counter transition in the same atomic store write before handoff.
8. **Replay provenance:** derive the Pi handoff without mutating the stored envelope. Prefix the cloned model content with the exact 56-byte ASCII text `[replayed after ambiguous restart; possible duplicate]\n\n`. Add closed internal details `{ deliveryReplay: { kind: "ambiguous-restart", possibleDuplicate: true } }`. The prefix and details are separate from canonical-envelope capacity accounting. Never expose the delivery ID, paths, routes, queue size, or compaction state.
9. **Graceful lifecycle:** reload, resume, fork, replacement, leave, and shutdown are graceful only when their hooks finish reconciliation before relinquishing the receiver. Close acceptance first. Retain `pending` for the same Manifest/Member. Complete evidence-present `handing-off`. Atomically change evidence-absent `handing-off` to `replay-blocked` without replay. A lifecycle interrupted before this finishes is a process crash and follows startup rules 2–6. Changed or removed Member identity never receives another Member's record.
10. **FIFO:** a `pending`, `handing-off`, or `replay-blocked` head record is reconciled before any later record; later direct delivery cannot overtake it.
11. **Acknowledgement:** remains persisted-only and never claims model delivery, reading, availability, completion, response, or exactly-once processing.
12. **Member Request exception:** its live response channel is not durable. It remains unacknowledged until safe handoff; channel/process loss before acknowledgement cancels it. After acknowledgement, ordinary requester offline/timeout semantics apply; never create a channel-less replayed Request after restart.
13. **Inbox/one-way/Interrupt/Response/Presence:** retain their original surface semantics; if eligible for ambiguous replay, reuse the same delivery ID and add only the defined replay provenance. Inbox removal remains after committed handoff evidence.
14. **No upstream changes:** use only published Pi 0.84.3 public APIs. The implementation and documentation must state the unavoidable duplicate window honestly.

At-most-once was rejected because it can silently discard acknowledged coordination. Explicit-only recovery was rejected as the first/default response because it would stall the global FIFO without attempting bounded automatic recovery. After the one reserved automatic replay is exhausted, retention and FIFO blocking are required until the future operator surface makes an explicit outcome.

## Acceptance criteria

- [x] Verify the public Pi 0.84.3 API boundary and feasibility evidence without modifying, forking, patching, or replacing upstream Pi.
- [x] Select one explicit loss/duplicate/recovery contract for the handoff crash window; document why the rejected alternatives are worse for Crew coordination.
- [x] Define guarantees separately for normal in-process delivery, graceful restart, process crash before Pi handoff, and ambiguous crash during/after Pi handoff.
- [x] Preserve the existing persisted-only deferred acknowledgement meaning; it must not claim model delivery or exactly-once processing.
- [x] Define stable delivery-ID, immutable envelope, replay counter/state, exact replay provenance, Inbox/Request/Interrupt behavior, FIFO ordering, and bounded `replay-blocked` operator outcome under the selected contract.
- [x] Deterministic recovery test requirements map `pending` to first handoff, evidence-present `handing-off` to completion, evidence-absent attempts 0 to one persisted replay reservation, and evidence-absent attempts 1 to `replay-blocked`, including crashes before and during replay invocation.
- [x] Graceful lifecycle test requirements close acceptance and reconcile without replay; interruption before reconciliation is covered as process-crash recovery.
- [x] Update TASK-0140 Desired outcome, Delivery contract, journal reconciliation, acceptance matrix, tests, and Ubiquitous Language so no exactly-once claim exceeds public evidence.
- [x] Obtain explicit Product acceptance and independent QA review of the revised contract before TASK-0140 production implementation resumes.

## Notes

Feasibility result: F1 PASS, F2 BLOCK, F3 PASS at exact clean `1c91fdaead3298e9d72ccc1caf98997ddaba7628`; watcher gen1143 fingerprint `35875274d1a7` PASS. `npm run verify:package` separately failed and does not affect the F2 impossibility finding.

Product accepts the bounded extension-only contract at exact clean `b84c9204a01dbd893a0d0a2e604edcd263b17401`. Kelly independently returned **ACCEPT** for that exact SHA with watcher generation 1162 PASS. This closes contract selection only; TASK-0140 implementation still requires explicit Lead reassignment and exact-head implementation QA.

