---
id: TASK-0031
title: Split crew follow-up and immediate messaging tools
status: todo
depends_on: [TASK-0024]
priority: high
tags: [crew, messaging, tools, ux]
---

# Split crew follow-up and immediate messaging tools

## Problem
One `send_to_member` tool exposes transport-oriented mode and wait combinations that are easy for agents to misuse; crew messaging needs two obvious user-intent tools for queued follow-up versus live steering, with completion correlated to the correct delivered message.

## Context

Replace the ambiguous member tool with two intent-named tools:

### `send_follow_up`

Queue a message behind the target's current turn. If target is busy, current work finishes before delivery. Follow-ups preserve FIFO order.

### `send_immediate`

Deliver into the target's active turn as a steer, allowing live redirection. If target is idle, delivery starts a normal turn.

Both tools accept `member` and `message`. Neither exposes a `mode` parameter: tool choice is the mode. **Follow-up is the default/recommended behavior** whenever the caller has not explicitly chosen urgency. Immediate steering is opt-in and its description must say to use it only when the new message should change active work. Use one shared application operation and thin registered-tool adapters in separate modules.

Return delivery acknowledgement by default so the sender does not block unnecessarily. Add optional `wait_for: accepted|response`; `response` must correlate to this delivery, never an unrelated current/previous `turn_end`. If Pi lifecycle APIs cannot prove delivery-level response correlation, characterize that limitation first and keep `response` unavailable with an explicit error rather than returning the wrong turn.

## Protocol contract

After TASK-0024, `message.send` uses user-facing delivery intent. Omitted delivery defaults to `follow_up`; immediate must always be explicit:

```json
{
  "delivery": "follow_up",
  "content": "Review this after your current task"
}
```

Successful acknowledgement includes a request-scoped delivery ID and actual disposition:

```json
{
  "deliveryId": "delivery-123",
  "disposition": "queued"
}
```

Disposition is `direct` when idle, `queued` for busy follow-up, or `steered` for busy immediate delivery.

## Implementation approach

1. Characterize Pi idle/busy `deliverAs: followUp|steer` behavior and turn lifecycle with deterministic integration seams before changing public tools.
2. Add delivery-intent/disposition schemas and request correlation to TASK-0024's shared protocol types.
3. Extract one application service that validates membership target, defaults omitted intent to follow-up, maps explicit intent to Pi delivery, preserves FIFO, and returns delivery ID/disposition.
4. Register one tool per module (`send-follow-up.ts`, `send-immediate.ts`) with fixed intent and shared compact parameters/results.
5. Remove `send_to_member` and its `mode` parameter atomically after both replacements are active; do not maintain three equivalent member-send paths.
6. Update tool activation/deactivation snapshots, docs, AGENTS guidance, examples, and integration tests.

## Acceptance criteria

- [ ] `send_follow_up` and `send_immediate` are the only crew-member message tools; each has one registered module and no caller-selectable mode.
- [ ] Follow-up is the documented/default selection policy and the protocol/application default when delivery intent is omitted; immediate behavior is never selected implicitly.
- [ ] Both resolve member name/unique role through current membership and preserve existing unjoined, unknown, ambiguous-role, self-send, offline, abort, and endpoint ownership errors.
- [ ] Busy `send_follow_up` queues behind current work in FIFO order and reports `queued`; it never steers the active turn.
- [ ] Busy `send_immediate` uses steer delivery, reports `steered`, and can redirect the active turn without waiting for completion.
- [ ] When target is idle, both start normal direct delivery and report `direct` without inventing a busy state.
- [ ] Default invocation returns after schema-valid acknowledgement with delivery ID/disposition and does not subscribe to global `turn_end`.
- [ ] Optional response waiting returns only the assistant response correlated to the requested delivery; tests prove a busy follow-up does not consume the current turn's completion and concurrent deliveries cannot cross responses.
- [ ] If exact response correlation is unsupported by Pi lifecycle events, `wait_for: response` is rejected explicitly and documented; no approximate/global turn result is returned.
- [ ] Follow-up ordering and immediate steering are deterministic under concurrent sends, aborts, target shutdown, and role switches.
- [ ] Tool descriptions teach agents to choose follow-up normally and immediate only to redirect active work, in one sentence each, without transport vocabulary beyond the user-facing distinction.
- [ ] Existing message origin, reply routing, instruction, and JSON-RPC schema work composes through shared payloads without duplicating metadata logic.
- [ ] `send_to_member` production registration, tests, docs, and active guidance are removed atomically; generic direct-session/CLI surfaces remain out of scope unless explicitly migrated later.
- [ ] Happy/unhappy, idle/busy, ordering, correlation, activation, protocol, and integration tests pass, followed by coverage/risk analysis and final watcher gate.

## Out of scope

- Splitting generic `send_to_session` into additional tools.
- Broadcast/multicast sends.
- Presence notifications, which use TASK-0029/0030.
- Pretending a global `turn_end` is delivery-correlated.

