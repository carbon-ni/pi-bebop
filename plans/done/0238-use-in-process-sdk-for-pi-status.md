---
id: TASK-0238
title: Use in-process SDK for Pi Member status tool
status: done
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

- [x] Extension composition injects a narrow status operation; the tool does not need unrelated mutable SocketState fields.
- [x] Preserve descriptions, result shape, cancellation and runtime trust/membership checks.
- [x] No source self-RPC, source discovery or environment-session dependency is introduced.
- [x] Operation sees current membership/trust after leave, rejoin or trust changes; no stale authority snapshots.
- [x] Integration tests prove read-only behavior, Guest exclusion, self/identity rejection and cancellation without starting/steering turns.
- [x] Exact-worktree verification passes: `fzz run --sequential --fail-fast @agent-final`; commit and push hooks passed.

## Delivery

- Code commit: `356c9a3` (`feat(pi): route member status through in-process SDK (TASK-0238)`).
- Draft PR: https://github.com/carbon-ni/pi-bebop/pull/48.

## Non-goals

Moving Pi events, context, delivery or other tools into SDK; changing runtime lifecycle. Follow `docs/SDK-REFACTOR.md`.
