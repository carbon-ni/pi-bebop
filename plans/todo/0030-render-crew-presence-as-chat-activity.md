---
id: TASK-0030
title: Render crew presence as chat activity
status: doing
depends_on: [TASK-0026, TASK-0029]
priority: normal
tags: [crew, presence, ux, docs]
---

# Render crew presence as chat activity

## Problem
Even with presence state and transport, members need concise, non-interrupting chat activity that shows the initial online roster and who subsequently joined or left without exposing internal transport details.

## Context

Render presence effects as concise custom chat activity:

```text
[crew] Online: lead (you), Bob (dev)
[crew] Kelly (qa) joined
[crew] Bob (dev) left
```

Use a dedicated `crew-presence` custom message with `display: true` and `triggerTurn: false`. Presence never interrupts, steers, or starts an agent turn. It remains in session history so the member/model can observe it on a later normal turn.

Choose chat-only notifications—no duplicate toast. Notifications default on through TASK-0028 config and can be disabled per manifest. `/crew members` from TASK-0026 remains the explicit current roster and shares member identity/status formatting where useful.

## Implementation approach

1. Write pure formatting tests before Pi wiring for empty/single/multiple rosters and joined/left effects.
2. Register a focused message renderer/composition callback; keep presence domain/runtime independent from TUI types.
3. Reuse manifest order and identity formatting, adding `(you)` only for exact current membership.
4. Bound/collapse large initial rosters while preserving total count and a clear `/crew members` hint when truncated.
5. Document default-on behavior, opt-out config, online meaning, crash delay, best-effort consistency, and examples.

## Acceptance criteria

- [ ] Initial scan emits one chat entry: ordered online roster with current member marked `(you)`; it does not replay joined messages for existing peers.
- [ ] Empty-peer roster is explicit and concise, e.g. `[crew] Online: lead (you)` or equivalent—not silent output.
- [ ] Later transitions render exactly `[crew] <name> (<role>) joined|left` once per reducer effect.
- [ ] Messages use `customType: "crew-presence"`, are visible, and always call Pi with `triggerTurn: false`.
- [ ] Presence activity creates no toast, automatic prompt, steer/follow-up delivery, callback route, or reply instruction.
- [ ] Output never includes configured endpoint paths, resolved global UUID sockets, session IDs, probe errors, or instruction content.
- [ ] Unknown/spoofed wire labels are never rendered directly; displayed name/role comes from local active manifest after runtime resolution.
- [ ] Manifest order remains deterministic, Unicode names/roles render safely, and content cannot inject fake extra presence entries.
- [ ] Large rosters use a named preview limit, include total count, and point to `/crew members` only when truncated.
- [ ] `presence.notifications: false` suppresses all presence chat activity while `/crew members` continues working.
- [ ] Leave/rejoin, role switch, crash, restore, reload, and shutdown integration tests prove no duplicate or post-stop activity.
- [ ] README and architecture docs explain chat-only default-on notifications, opt-out configuration, reachable-not-idle meaning, reconciliation delay, and best-effort guarantees.
- [ ] Formatter, renderer, Pi integration, truncation, adversarial, and lifecycle tests pass, followed by coverage/risk analysis and final watcher gate.

## Out of scope

- Toasts, sounds, desktop notifications, unread counters, or presence history views.
- Starting agent turns in response to presence changes.
- Busy/idle status or typing indicators.
- Editing crew membership from presence messages.

