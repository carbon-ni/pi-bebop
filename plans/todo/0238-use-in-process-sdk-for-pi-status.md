---
id: TASK-0238
title: Use in-process SDK for Pi Member status tool
status: todo
depends_on: [TASK-0236]
priority: high
tags: [sdk, pi, status, tdd]
---

# Use in-process SDK for Pi status

## Problem

Pi status-tool wiring bypasses the SDK operation, leaving divergent adaptation paths.

## Desired outcome

Pi tool registration/presentation stays at the Pi edge while status executes through the in-process SDK adapter.

## Acceptance criteria

- [ ] Extension composition injects a narrow status operation; the tool does not need unrelated mutable SocketState fields.
- [ ] Preserve descriptions, result shape, cancellation and runtime trust/membership checks.
- [ ] No source self-RPC, source discovery or environment-session dependency is introduced.
- [ ] Operation sees current membership/trust after leave, rejoin or trust changes; no stale authority snapshots.
- [ ] Integration tests prove read-only behavior, Guest exclusion, self/identity rejection and cancellation without starting/steering turns.
- [ ] Exact-head watcher/GitHub gates pass.

## Non-goals

Moving Pi events, context, delivery or other tools into SDK; changing runtime lifecycle. Follow `docs/SDK-REFACTOR.md`.
