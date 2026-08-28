---
id: TASK-0137
title: Verify and document crew-to-crew correspondence
status: done
depends_on: [TASK-0136]
priority: normal
tags: [crew, messaging, intake, verification, documentation, cross-project]
---

## Problem

A persisted message and a green unit test do not prove that two Crews can conduct an honest asynchronous exchange without leaking live routes or overstating delivery. The public convention needs independent end-to-end evidence and concise operator guidance.

## Acceptance criteria

- [x] Independent matrix maps every TASK-0136 criterion to executable evidence at one exact commit.
- [x] Black-box exchange proves Crew A asks through Crew B's absolute Manifest path, B receives claimed Origin + Crew Return Address after offline handoff, B replies with the same tool, and A receives the answer.
- [x] Both supported layouts work in either source/target direction; unnamed and named Crews behave identically except optional display label.
- [x] Failure matrix covers unjoined/stale Membership, non-absolute/self/unsupported/unsafe paths, unreadable/invalid Manifest, disabled/unknown contact, malformed/oversized payload, Inbox capacity, lock conflict, and storage failure with zero partial persistence.
- [x] Privacy inspection proves no session IDs, aliases, sockets, callback routes, hidden/system/Role instructions, credentials, stacks, or automatic filesystem IO from received return addresses.
- [x] Deterministic restart/offline tests prove persistence without claiming notification, read, Response, completion, availability, or authentication.
- [x] README and ubiquitous language define Crew Correspondence and Crew Return Address, explain two one-way letter turns with an ask/reply example, and state same-machine, claimed-origin, stale-path, and no-thread limits.
- [x] CLI `send --crew <path>` documentation remains external/unverified and does not falsely advertise automatic Crew Origin or reply behavior.
- [x] Focused coverage, typecheck, formatting, lint, architecture/package checks, fresh full watcher gate, and unchanged-worktree proof pass.

## Evidence matrix

| TASK-0136/TASK-0137 criterion | Executable or documentation evidence |
| --- | --- |
| Exact-commit, public two-Crew exchange | `src/tools/send-to-crew.integration.test.ts` registers and invokes the public tool against two real temporary projects, then makes the recipient's real Inbox bridge `attemptOffer()` the handoff boundary. |
| Both layouts, both directions, named/unnamed compatibility | Same test covers named `.pi/bebop` → `.pi/crew` → reply and unnamed `.pi/crew` → `.pi/bebop` → reply; assertions prove labels are optional only. |
| Offline persistence and one-way reply | Same test leaves recipient socket absent, asserts persisted-only result, explicit bridge Follow-up, claimed return address, then invokes a separate explicit public-tool reply. |
| Rejection/no partial persistence | `src/application/crew-correspondence.test.ts`, `src/tools/send-to-crew.test.ts`, and `src/infra/crew-intake-reader.test.ts` cover membership, path, manifest, contact, payload, capacity, lock/write, and foreign-layout symlink failures. |
| Metadata/privacy and receiver boundary | Public test asserts typed `messagePayload`/Inbox details, no `replyTo`/session/socket/alias material, and recipient-derived Inbox label; `src/domain/message-renderer.test.ts` and `src/pi/message-renderer.test.ts` assert claimed return-address rendering and callback privacy. |
| Restart/offline durability | `src/pi/inbox-lifecycle.integration.test.ts` covers later handoff, durable evidence reconciliation, restart/crash, FIFO, and no delivery/completion claims. |
| Operator contract | README "Crew Correspondence" and UL entries/relationships define the explicit two-letter flow, claimed/stale/same-machine/no-thread limits, and keep `pi-bebop send --crew` external/unverified. |
| Gates | Focused matrix, full hook, and fresh unchanged-worktree `@agent-final` watcher results are recorded in `.tmp/reports/13-04-26/task-0137-verification.md`. |

## Non-goals

Registry/discovery, short-name addressing, cross-machine transport, automatic Response routing, conversation threads, delivery/read receipts, authentication, encryption, or changing Crew Intake contact policy.
