---
id: TASK-0143
title: Redesign compaction delivery guarantee within Pi public APIs
status: doing
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

Product selected **at-least-once across the ambiguous crash window**. Acknowledged journal work must not be silently lost. A process crash may cause one replay attempt with the same stable delivery ID when durable Pi session evidence is absent, even if Pi had consumed the first handoff before crashing. Such a replay is a possible duplicate, not a new message or a new acceptance.

The bounded contract is:

1. **Before durable journal append:** no acknowledgement, no ownership, no later replay.
2. **After append and before Pi handoff:** retain `pending`; restart replays in original sequence.
3. **After `handing-off` and with durable typed Pi evidence present:** complete the journal record; never replay.
4. **After `handing-off` and with evidence absent:** treat the window as ambiguous and replay once per recovery attempt using the same delivery ID and envelope. Persist replay-attempt state before invoking Pi.
5. **Replay provenance:** add bounded structured metadata and model-visible provenance saying the delivery was replayed after an ambiguous restart and may be a duplicate. Do not expose the delivery ID, paths, routes, queue size, or compaction state.
6. **FIFO:** an ambiguous head record is reconciled or replayed before any later record; later direct delivery cannot overtake it.
7. **Acknowledgement:** remains persisted-only and never claims model delivery, reading, availability, completion, response, or exactly-once processing.
8. **Member Request exception:** its live response channel is not durable. It remains unacknowledged until safe handoff; channel/process loss before acknowledgement cancels it. After acknowledgement, ordinary requester offline/timeout semantics apply; never create a channel-less replayed Request after restart.
9. **Inbox/one-way/Interrupt/Response/Presence:** retain their original surface semantics; if eligible for durable replay, reuse the same delivery ID and mark only replay provenance. Inbox removal remains after committed handoff evidence.
10. **No upstream changes:** use only published Pi 0.84.3 public APIs. The implementation and documentation must state the unavoidable duplicate window honestly.

At-most-once was rejected because it can silently lose acknowledged coordination. Explicit recovery was rejected as the default because it can indefinitely stall the global FIFO and requires an operator surface outside TASK-0140.

## Acceptance criteria

- [ ] Verify the public Pi 0.84.3 API boundary and feasibility evidence without modifying, forking, patching, or replacing upstream Pi.
- [ ] Select one explicit loss/duplicate/recovery contract for the handoff crash window; document why the rejected alternatives are worse for Crew coordination.
- [ ] Define guarantees separately for normal in-process delivery, graceful restart, process crash before Pi handoff, and ambiguous crash during/after Pi handoff.
- [ ] Preserve the existing persisted-only deferred acknowledgement meaning; it must not claim model delivery or exactly-once processing.
- [ ] Define stable delivery-ID, replay provenance, Inbox/Request/Interrupt behavior, FIFO ordering, and operator recovery under the selected contract.
- [ ] Update TASK-0140 Desired outcome, Delivery contract, journal reconciliation, acceptance matrix, tests, and Ubiquitous Language so no exactly-once claim exceeds public evidence.
- [ ] Obtain explicit Product acceptance and independent QA review of the revised contract before TASK-0140 production implementation resumes.

## Notes

Feasibility result: F1 PASS, F2 BLOCK, F3 PASS at exact clean `1c91fdaead3298e9d72ccc1caf98997ddaba7628`; watcher gen1143 fingerprint `35875274d1a7` PASS. `npm run verify:package` separately failed and does not affect the F2 impossibility finding.

