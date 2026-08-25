---
id: TASK-0089
title: Consume inbound messages before continuing Member Idle Wait
status: doing
depends_on: []
priority: high
tags: [member-idle, messaging, lifecycle, pi-api, regression, tdd]
---

# Consume inbound messages before continuing Member Idle Wait

## Problem

When `wait_for_member_idle` is released by an accepted Bebop message, its
ordinary tool-result continuation can run before the queued message reaches
model context. The agent can therefore reason from `message-received`, call
more tools, or wait again without seeing the message that woke it.

The wait must stop when an inbound Bebop message wins, and that unchanged
message must be consumed by the agent in the immediate queued continuation.

## Current evidence

- `notifyAcceptedMessage` claims the wake before `pi.sendMessage` submits the
  unchanged message.
- A busy Follow-up uses Pi `deliverAs: "followUp"`. Pi intentionally withholds
  it until the agent has no more tool calls.
- `wait_for_member_idle` currently returns an ordinary `message-received` tool
  result, permitting another model call before Pi drains the Follow-up queue.
- Pi 0.84.2 supports `terminate: true` on a tool result. When every result in
  the current tool batch terminates, Pi skips the ordinary tool-result model
  continuation; its post-run loop can then drain the queued Follow-up.
- Existing tests prove wake, cancellation, and `sendMessage` submission, but
  stop at the adapter boundary. They do not prove which message the model
  consumes next.

## Product contract

When an accepted Bebop model-bound message wins a blocking Member Idle Wait:

```text
accepted inbound message
  -> claim message wake
  -> cancel remote idle subscription
  -> submit unchanged message with original delivery mode
  -> finish wait with message-received + terminating result
  -> skip content-free wait continuation
  -> consume queued inbound message in next model continuation
```

The `message-received` result remains persisted and visible as honest lifecycle
evidence. Termination controls scheduling only; it must not remove, inspect,
copy, rewrite, or reorder the inbound message.

`already-idle`, `became-idle`, `offline`, and `timeout` remain ordinary tool
results so the agent can reason about those outcomes. Abort and errors retain
their existing behavior.

## Implementation plan

1. Add a failing Pi-host characterization around a real registered
   `wait_for_member_idle` tool, a deterministic fake model, and captured model
   contexts. Reproduce: busy target, accepted Follow-up, wake result, and show
   the undesired provider call that lacks the inbound message.
2. Extend the local tool result type and return `terminate: true` only for the
   `message-received` terminal.
3. Keep wake-gate ownership, first-terminal arbitration, remote cancellation,
   and `followUp`/`steer` selection unchanged.
4. Prove full context order at Pi boundary, not only `pi.sendMessage` calls:
   the next provider context after wake contains the exact inbound custom
   message, once, before any new assistant action.
5. Characterize Pi's “every result in batch must terminate” rule. Make
   `wait_for_member_idle` a solitary/sequential coordination call in its tool
   affordance and regression test. If Pi still permits a non-terminating
   sibling to create a message-free continuation, do not weaken the guarantee:
   record it as an upstream Pi API blocker and keep this task open.
6. Update Member Idle Wait docs to state immediate message consumption and the
   solitary-call requirement; remove wording that only promises eventual
   processing after tool return.

## Acceptance criteria

- [ ] A red test reproduces the bug through Pi's real tool/agent continuation loop, not a mocked `sendMessage` assertion.
- [ ] Accepted Follow-up resolves the wait once, cancels the remote subscription, and returns `message-received` with `terminate: true`.
- [ ] The next model continuation contains the exact waking message; no intermediate provider call sees only the wait result.
- [ ] The waking message is consumed exactly once and retains its original payload, instructions, origin, and FIFO position.
- [ ] Redirect still preserves steer semantics and is consumed at its documented turn boundary.
- [ ] A second accepted message remains ordered behind the first and is not dropped by termination cleanup.
- [ ] Same-boundary message/idle arbitration and all listener, timer, signal, and socket cleanup behavior remain unchanged.
- [ ] Already-idle, became-idle, offline, timeout, abort, and error paths do not gain accidental terminating behavior.
- [ ] Solitary/sequential invocation and Pi's all-results termination constraint are covered by tests and public tool guidance; unresolved mixed-batch behavior blocks completion.
- [ ] `docs/MEMBER-IDLE-WAIT.md` and README describe immediate consumption without claiming task completion or response correlation.
- [ ] Focused tests, Bebop final gate, and unchanged-worktree freshness proof pass.

## Out of scope

- Changing `wait_for_request_outcome`.
- Reading Pi private queues or storing message content in the wake gate.
- Converting Follow-up into Redirect or changing sender-facing delivery intent.
- Treating message receipt as target idle, acknowledgement, response, or task completion.
