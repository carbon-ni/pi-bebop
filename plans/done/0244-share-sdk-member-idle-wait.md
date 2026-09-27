---
id: TASK-0244
title: Share SDK Member idle wait with Pi wake adaptation
status: done
depends_on: [TASK-0238]
priority: normal
tags: [sdk, waits, lifecycle, tdd]
---

# Share Member idle wait

## Problem

Idle observation and Pi continuation/wake logic must be separated before sharing waits safely.

## Desired outcome

SDK exposes bounded idle waiting; CLI and Pi use the same observation operation with native cancellation and wake adapters.

## Acceptance criteria

- [x] Share the existing wait/subscription operation without polling or a second state registry.
- [x] Distinguish idle, offline, timeout, abort and Pi inbound-message wake; none proves task completion.
- [x] Pi wake/continuation consumption stays at its edge and releases waits without discarding queued messages.
- [x] Tests cover subscribe/idle races, compaction, inbound Follow-up, exact cleanup on disconnect/abort, timeout and lifecycle invalidation.
- [x] Preserve current output contracts and bounds; no source self-RPC or active-turn interruption.
- [x] Packed consumers and exact-head gates pass.

## Non-goals

Progress monitoring, generic event streams or unbounded waits. Follow `docs/SDK-REFACTOR.md`.

## Evidence

- Implementation: `9f47eb4`.
- Draft PR: #49.
- Exact-head watcher generation 10 passed `npm test`, `npm run format:check`, `npm run lint`, upstream CI, `make all`, and `npm run verify:cli`.
- Follow-up fix preserves `capacity-exceeded` as a distinct SDK error from remote rejection.
