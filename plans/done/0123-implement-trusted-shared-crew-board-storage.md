---
id: TASK-0123
title: Implement trusted shared Crew Board storage
status: done
depends_on: [TASK-0122]
priority: high
tags: [crew, board, domain, infra, persistence, filesystem, atomicity, tdd]
---

# Implement trusted shared Crew Board storage

## Problem

The Crew Board needs one crash-safe manifest-adjacent store that every Current Member can share without per-Member copies, access tiers, lost concurrent appends, or one corrupt record blocking the board.

## Storage shape

```text
<active-layout>/board/
  .lock
  posts/<post-id>.json
  quarantine/
```

Use the active trusted manifest layout only. `.pi/bebop` and `.pi/crew` remain isolated compatibility layouts and are never mirrored.

## Implementation plan

1. Write failing domain tests for the closed versioned Crew Post schema, canonical bytes, safe references/links, ordering, limits, and exact replay/conflict semantics.
2. Add a domain Board operation contract independent of filesystem and Pi APIs.
3. Implement an injected trusted store with one canonical Post per file, exact ownerHash lock contract, temporary write, atomic no-replace publish, and corruption quarantine, following proven Inbox/Retrospective boundaries without copying their overwrite/stale-lock assumptions.
4. Read and validate bounded file metadata before content, then return stable `(sequence,id)` order with deterministic cursor/filter/limit behavior.
5. Add `board/` to runtime-owned layout ignore rules without ignoring manifest/instruction configuration.

## Acceptance criteria

- [ ] TDD covers valid append/read before implementation and all validation, concurrency, crash, corruption, trust, and capacity failure paths.
- [ ] Closed schema rejects unknown version/fields, invalid UTF-8/NUL, oversized message/record, invalid kind, unsafe reference/link, invalid author/time/sequence/id, and non-canonical data before publication.
- [ ] Store opens only beside one validated trusted Crew manifest and rejects traversal, symlink escape, foreign layout, unsupported layout, and untrusted project before record IO.
- [ ] One accepted post becomes one versioned canonical JSON file; no shared JSONL rewrite or per-Member board directory exists.
- [ ] One lock critical section covers replay/conflict, quarantine, healthy capacity, link validation, sequence/time allocation, temp write, and no-replace publish. Acquisition is bounded; every path releases only its own ownerHash once.
- [ ] Concurrent appends are lossless, exact-once by operation identity, and produce stable contiguous acceptance order independent of filesystem enumeration.
- [ ] Exact retry returns the existing post unchanged; same identity with different canonical bytes is an idempotency conflict and never overwrites.
- [ ] Crash before no-replace publish leaves no Post; crash after publish leaves one complete Post. Lock acquisition/release follows the bounded ownerHash contract; stale locks are never age/PID-stolen and require explicit trusted maintenance. Temp recovery after that boundary cannot delete another live writer's state.
- [ ] Malformed, oversized, foreign, or tampered records are quarantined deterministically while healthy posts remain readable; quarantine failure is explicit.
- [ ] Missing-Board read creates nothing and returns canonical empty. Other reads never mutate healthy Posts/per-Member state; invalid-file quarantine is the sole explicit repair mutation. Empty, kind-filtered, filter-bound after-cursor, invalid/foreign cursor, truncation, quarantine diagnostics, and directory/canonical capacity cases are bounded.
- [ ] Injected clock, filesystem, lock, fingerprint/ID, and limits make tests deterministic and avoid network or Pi runtime dependencies.
- [ ] Both canonical and compatibility layouts pass isolated integration tests; data is never mirrored or merged between them.
- [ ] No store method sends messages, inspects sessions, mutates Membership, changes tasks/Agreements, or interprets post content.

## Non-goals

Agent tools, slash commands, delete/edit UI, search index, network replication, Git synchronization, automatic promotion, or Retrospective interpretation.
