---
id: TASK-0123
title: Implement trusted shared Crew Board storage
status: todo
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
3. Implement an injected trusted store with one canonical post per file, bounded exclusive board lock, temporary write, atomic rename, and corruption quarantine, following existing Inbox/Retrospective storage patterns without coupling stores.
4. Read and validate bounded file metadata before content, then return stable `(sequence,id)` order with deterministic cursor/filter/limit behavior.
5. Add `board/` to runtime-owned layout ignore rules without ignoring manifest/instruction configuration.

## Acceptance criteria

- [ ] TDD covers valid append/read before implementation and all validation, concurrency, crash, corruption, trust, and capacity failure paths.
- [ ] Closed schema rejects unknown version/fields, invalid UTF-8/NUL, oversized message/record, invalid kind, unsafe reference/link, invalid author/time/sequence/id, and non-canonical data before publication.
- [ ] Store opens only beside one validated trusted Crew manifest and rejects traversal, symlink escape, foreign layout, unsupported layout, and untrusted project before record IO.
- [ ] One accepted post becomes one versioned canonical JSON file; no shared JSONL rewrite or per-Member board directory exists.
- [ ] Lock covers sequence allocation, capacity check, idempotency/conflict check, temp write, and atomic publish. Lock acquisition is bounded and every path releases once.
- [ ] Concurrent appends are lossless, exact-once by operation identity, and produce stable contiguous acceptance order independent of filesystem enumeration.
- [ ] Exact retry returns the existing post unchanged; same identity with different canonical bytes is an idempotency conflict and never overwrites.
- [ ] Crash before rename publishes nothing; crash after rename leaves one complete post. Stale temp/lock recovery is bounded and cannot delete another live writer's state.
- [ ] Malformed, oversized, foreign, or tampered records are quarantined deterministically while healthy posts remain readable; quarantine failure is explicit.
- [ ] Reads are non-mutating, bounded, and byte-stable for unchanged state; empty, kind-filtered, after-cursor, invalid cursor, missing cursor, truncation, and capacity cases are explicit.
- [ ] Injected clock, filesystem, lock, fingerprint/ID, and limits make tests deterministic and avoid network or Pi runtime dependencies.
- [ ] Both canonical and compatibility layouts pass isolated integration tests; data is never mirrored or merged between them.
- [ ] No store method sends messages, inspects sessions, mutates Membership, changes tasks/Agreements, or interprets post content.

## Non-goals

Agent tools, slash commands, delete/edit UI, search index, network replication, Git synchronization, automatic promotion, or Retrospective interpretation.
