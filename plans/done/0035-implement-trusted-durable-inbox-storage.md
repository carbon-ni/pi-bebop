---
id: TASK-0035
title: Implement trusted durable inbox storage
status: done
depends_on: [TASK-0034]
priority: high
tags: [crew, inbox, infra, persistence, security]
---

# Implement trusted durable inbox storage

## Problem
Inbox messages must survive process restarts and crashes without relying on transient Pi follow-up queues, while preserving project trust, member isolation, deterministic ordering, and recoverability.

## Context

Implement only durable pending-message repository from TASK-0034. Storage belongs to trusted crew layout; it knows no tasks, branches, reviews, worker status, or Pi APIs. Multiple sender processes may enqueue concurrently.

## Implementation approach

1. Write filesystem contract tests first using temporary layouts and injected failure seams.
2. Store one versioned item per file beneath active trusted layout using safe canonical member key.
3. Use atomic create/rename and stable IDs; never expose partial records.
4. Provide small repository API: enqueue, peek oldest, list bounded metadata, remove, cancel, count.
5. Quarantine malformed record so one bad file does not block healthy queue.

## Acceptance criteria

- [ ] Project trust is checked before any inbox IO; unsupported layouts and symlink escapes are rejected.
- [ ] Atomic enqueue survives restart and never publishes partial JSON.
- [ ] Concurrent writers cannot overwrite IDs, corrupt FIFO order, or lose accepted items.
- [ ] Peek/list return deterministic per-member order and bounded metadata without message-content leaks by default.
- [ ] Remove/cancel are idempotent; no general workflow state machine is introduced.
- [ ] Storage key is safe from traversal, Unicode collision, and role/name changes defined by TASK-0034.
- [ ] Schema/version, size/count limits, malformed data, disk-full, and permission failures return bounded actionable errors.
- [ ] Both trusted layouts and external-root membership use manifest-adjacent isolated storage.
- [ ] Deterministic happy/unhappy, concurrency, crash-window, and security tests pass.

## Out of scope

- Task state, retries/backoff engine, scheduler, Git, remote database, or central queue service.
