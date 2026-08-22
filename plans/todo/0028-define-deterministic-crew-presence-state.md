---
id: TASK-0028
title: Define deterministic crew presence state
status: todo
depends_on: [TASK-0022]
priority: high
tags: [crew, presence, domain, determinism]
---

# Define deterministic crew presence state

## Problem
Crew endpoint liveness exists only as ad-hoc probes; without one explicit state model, initial roster, transient failures, duplicate events, and join/leave transitions will produce noisy or contradictory presence notifications.

## Context

Model presence as pure state per non-current manifest member:

- `unknown` — no completed observation yet.
- `online` — endpoint was reachable.
- `suspect` — one failed probe; remain visibly online and emit nothing.
- `offline` — consecutive failures confirmed departure.

Only successful/failed endpoint observations change authoritative displayed state. Incoming wire events are lightweight hints that request an immediate probe; they do not establish trusted presence by themselves.

Initial observation produces one roster effect instead of one joined event per already-online member. Later `offline → online` emits `joined`; confirmed `online/suspect → offline` emits `left`; duplicate observations are no-ops.

Add optional manifest configuration:

```json
{
  "presence": { "notifications": true }
}
```

Notifications default to `true` for a joined crew. `false` disables presence broadcasts, observation, and chat activity without changing `/crew list`.

## Implementation approach

1. Write reducer tests first as state/input/effects tables; use no real clocks, sockets, randomness, or timers.
2. Add immutable domain types for member identity, member presence, observation inputs, initial-scan completion, and `roster|joined|left` effects.
3. Keep manifest order as explicit input/output ordering; never derive order from probe completion.
4. Add strict optional `presence.notifications` manifest parsing while preserving v1 manifests without the field.
5. Use a named consecutive-failure threshold and expose reducer state for runtime composition, not UI formatting.

## Acceptance criteria

- [ ] Pure reducer covers `unknown`, `online`, `suspect`, and `offline` without IO, time, random IDs, or mutation.
- [ ] Initial observations emit exactly one ordered roster effect after the complete scan and no joined/left effects.
- [ ] `offline → online` emits one joined effect; repeated successes emit nothing.
- [ ] One failed online probe enters suspect without emitting left; configured consecutive failure confirms offline and emits exactly one left effect.
- [ ] `suspect → online` silently recovers; further offline failures after confirmed offline emit nothing.
- [ ] Probe results arriving out of order cannot change manifest output order or duplicate effects.
- [ ] Current member is excluded by explicit identity, not role/name heuristics, and never produces self-presence effects.
- [ ] Leave/rejoin and role-switch sequences produce deterministic old-member left/new-member joined effects.
- [ ] Manifest accepts only optional `{ presence: { notifications: boolean } }`, rejects unknown/wrong fields, and defaults notifications to enabled.
- [ ] Disabling notifications yields no observer effects while preserving crew membership and `/crew list` semantics.
- [ ] Table-driven happy/unhappy/duplicate/recovery/config tests pass, followed by coverage and complexity review.

## Out of scope

- Socket probing, timers, JSON-RPC, or Pi UI integration.
- Busy/idle/available status; online means endpoint reachable only.
- Persisting presence across process restarts.

