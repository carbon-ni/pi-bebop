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

- [x] A red test reproduces the bug through Pi's real tool/agent continuation loop, not a mocked `sendMessage` assertion. (RED validated 28-08: with `terminate` disabled, `member-idle-continuation.integration.test.ts` tests 1 and 3 fail with a content-free continuation; re-enabled they pass. Fake provider + real registered tool + real `handleCommand` send path + real Pi queue.)
- [x] Accepted Follow-up resolves the wait once, cancels the remote subscription, and returns `message-received` with `terminate: true`. (Host test 1 + existing TASK-0081 suites.)
- [x] The next model continuation contains the exact waking message; no intermediate provider call sees only the wait result. (Host test 1: exactly 2 provider calls; context 2 = [user, assistant toolCall, toolResult, waking message].)
- [x] The waking message is consumed exactly once and retains its original payload, instructions, origin, and FIFO position. (Host tests 1 and 3; rendered model content keeps follow-up header and exact payload; FIFO across drain turns.)
- [x] Redirect still preserves steer semantics and is consumed at its documented turn boundary. (Host test 2; characterized: steer is delivered before the next LLM call regardless of termination — Pi steer semantics, no dependency on `terminate`.)
- [x] A second accepted message remains ordered behind the first and is not dropped by termination cleanup. (Host test 3: msg1 drives turn 2, msg2 drives turn 3 — Pi drains one queued Follow-up per turn; neither dropped.)
- [x] Same-boundary message/idle arbitration and all listener, timer, signal, and socket cleanup behavior remain unchanged. (No production code changed; existing TASK-0080/0081 suites green.)
- [x] Already-idle, became-idle, offline, timeout, abort, and error paths do not gain accidental terminating behavior. (`wait-for-member-idle.test.ts` asserts `terminate` falsy for offline/became-idle; mapping `terminate: outcome === "message-received"` unchanged.)
- [x] Solitary/sequential invocation and Pi's all-results termination constraint are covered by tests and public tool guidance. Mixed-batch behavior is now RESOLVED as a characterized upstream constraint (see blocker below) — NOT an unknown.
- [x] `docs/MEMBER-IDLE-WAIT.md` and README describe immediate consumption without claiming task completion or response correlation. (The standalone doc file was removed by `538d2a9`; the contract lives in README "consumed immediately in the next model continuation" and the tool description "Call this coordination wait alone/sequentially, never in a parallel tool batch".)
- [x] Focused tests, Bebop final gate, and unchanged-worktree freshness proof pass. (Focused 19/19 across continuation/wake/tool suites; watcher gen 306 `@agent-final` PASS: format-check, lint, arch-check, build, full suite; worktree clean of unintended production changes — `src/tools/wait-for-member-idle.ts` is byte-identical to HEAD.)

## Upstream Pi API blocker (28-08, characterized mechanically)

`member-idle-continuation.integration.test.ts` test 4 pins the rule: Pi
skips the tool-result continuation only when EVERY result in the batch
terminates. One `terminate: true` wait result plus a non-terminating sibling
(`bebop_noop`) still produces an ordinary content-free continuation (context
with tool results only), and the waking message is consumed one turn later.
Nothing is dropped, but immediate consumption is NOT guaranteed for mixed
batches. Per this plan's rule this is recorded as an upstream Pi API
constraint: Bebop cannot close it from the tool side without weakening the
guarantee. The public tool guidance already mandates a solitary/sequential
call; the task therefore stays `doing` (open) until Pi offers per-result
batch termination semantics or the crew accepts the constraint as final.

## Out of scope

- Changing `wait_for_request_outcome`.
- Reading Pi private queues or storing message content in the wake gate.
- Converting Follow-up into Redirect or changing sender-facing delivery intent.
- Treating message receipt as target idle, acknowledgement, response, or task completion.
