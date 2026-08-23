---
id: TASK-0038
title: Verify and document durable crew inbox lifecycle
status: doing
depends_on: [TASK-0036, TASK-0037]
priority: high
tags: [crew, inbox, integration, docs, recovery]
---

# Verify and document durable crew inbox lifecycle

## Problem
A restart-safe inbox introduces failure and recovery expectations that must be proven end to end and explained without implying exactly-once execution or role-based authority that the product does not provide.

## Context

Close minimal transport feature with evidence across sender/recipient sessions, offline enqueue, restart, FIFO handoff, cancellation/pause, and honest language. Bebop delivers durable messages; it does not manage software workflow.

## Acceptance criteria

- [ ] End-to-end: member persists message for offline peer; peer later joins and receives it as follow-up.
- [ ] Existing live follow-ups queued before inbox handoff remain ahead; inbox never redirects active turn.
- [ ] Restart/crash-window tests prove stable-ID reconciliation without message loss or uncontrolled duplication.
- [ ] Concurrent sender tests prove deterministic order and no accepted item loss.
- [ ] Bounded `/crew inbox` list/cancel/pause/resume UX from TASK-0037 works across restart without mailbox complexity.
- [ ] Failure/security tests cover malformed item, full inbox, disk failure, untrusted/layout confusion, traversal, symlink escape, spoofed origin, and unsafe member names.
- [ ] Output distinguishes persisted from handed-to-session; it never claims task completion or response.
- [ ] README shows simple lead-to-peer offline message and explicitly states no task/Git/review integration.
- [ ] Architecture and `UL.md` document small inbox boundary and distinction from follow-up/redirect.
- [ ] Package smoke, focused tests, coverage/risk analysis, and final watcher gate pass.

## Out of scope

- Task board, work status, Git/worktrees, CI, review workflow, shared pool, cross-machine delivery, broadcast, or exactly-once execution claims.
