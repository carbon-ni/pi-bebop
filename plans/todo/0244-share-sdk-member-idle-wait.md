---
id: TASK-0244
title: Share SDK Member idle wait with Pi wake adaptation
status: todo
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

- [ ] Share the existing wait/subscription operation without polling or a second state registry.
- [ ] Distinguish idle, offline, timeout, abort and Pi inbound-message wake; none proves task completion.
- [ ] Pi wake/continuation consumption stays at its edge and releases waits without discarding queued messages.
- [ ] Tests cover subscribe/idle races, compaction, inbound Follow-up, exact cleanup on disconnect/abort, timeout and lifecycle invalidation.
- [ ] Preserve current output contracts and bounds; no source self-RPC or active-turn interruption.
- [ ] Packed consumers and exact-head gates pass.

## Non-goals

Progress monitoring, generic event streams or unbounded waits. Follow `docs/SDK-REFACTOR.md`.
