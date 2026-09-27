---
id: TASK-0245
title: Share SDK live Crew Broadcast
status: todo
depends_on: [TASK-0240]
priority: normal
tags: [sdk, broadcast, tdd]
---

# Share live Crew Broadcast

## Problem

Fan-out semantics can drift if SDK, CLI and Pi each implement their own roster and failure handling.

## Desired outcome

All surfaces use the existing runtime Broadcast operation and shared Follow-up delivery.

## Acceptance criteria

- [ ] Remote/in-process SDK adapters reuse runtime Broadcast; migrate CLI and Pi callers.
- [ ] Preserve deterministic roster order, sender exclusion, current Guest capability rules and partial failure reporting.
- [ ] Each eligible recipient is attempted once; offline/rejected recipients do not stop later attempts.
- [ ] No durable Inbox fallback, correlated Response, steering or automatic retry is introduced.
- [ ] Tests cover mixed outcomes, cancelled fan-out and existing authority behavior.
- [ ] Packed consumers and exact-head gates pass.

## Non-goals

Broadcast Ask, recipient reassignment or new delivery guarantees. Follow `docs/SDK-REFACTOR.md`.
