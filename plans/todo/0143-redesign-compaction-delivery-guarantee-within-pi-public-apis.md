---
id: TASK-0143
title: Redesign compaction delivery guarantee within Pi public APIs
status: todo
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

The recommended starting point is at-least-once with stable delivery IDs and explicit replay provenance because acknowledged message loss is less recoverable than an observable duplicate. This recommendation is not accepted until Product locks the tradeoff.

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

