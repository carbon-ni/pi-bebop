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

The supported invocation is one solitary/sequential `wait_for_member_idle` tool
call: the assistant must not place it in a parallel tool-call batch. For that
supported invocation, when an accepted Bebop model-bound message wins:

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

A mixed tool-call batch is outside this immediate-consumption guarantee. Pi
0.84.x continues when any sibling result is non-terminating, so one
content-free tool-result continuation may occur before the unchanged waking
message is consumed exactly once on the following turn. Bebop must not change
the sender's delivery mode, terminate unrelated sibling results, duplicate the
message, inspect Pi private queues, or claim that mixed-batch consumption was
immediate. Public guidance must keep the solitary/sequential precondition.

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
   affordance and regression test. Pin the mixed-batch behavior as an accepted
   upstream limitation outside the supported immediate-consumption contract;
   do not weaken the solitary-call guarantee or alter sibling results.
6. Update Member Idle Wait docs to state immediate message consumption and the
   solitary-call requirement; remove wording that only promises eventual
   processing after tool return.

## Acceptance criteria

- [x] A red test reproduces the bug through Pi's real tool/agent continuation loop, not a mocked `sendMessage` assertion. (RED validated 28-08: with `terminate` disabled, `member-idle-continuation.integration.test.ts` tests 1 and 3 fail with a content-free continuation; re-enabled they pass. Fake provider + real registered tool + real `handleCommand` send path + real Pi queue.)
- [x] Accepted Follow-up resolves the wait once, cancels the remote subscription, and returns `message-received` with `terminate: true`. (Host test 1 + existing TASK-0081 suites.)
- [x] The next model continuation contains the exact waking message; no intermediate provider call sees only the wait result. (Host test 1: exactly 2 provider calls; context 2 = [user, assistant toolCall, toolResult, waking message].)
- [ ] The waking message is consumed exactly once and retains its full original payload, ordered instructions, claimed origin, and FIFO position at the real Pi-host/provider-context boundary. (Content, mode, once-only behavior, and FIFO are proved; Kelly requires the focused full-`MessagePayload` field/order assertion before closure.)
- [x] Redirect still preserves steer semantics and is consumed at its documented turn boundary. (Host test 2; characterized: steer is delivered before the next LLM call regardless of termination — Pi steer semantics, no dependency on `terminate`.)
- [x] A second accepted message remains ordered behind the first and is not dropped by termination cleanup. (Host test 3: msg1 drives turn 2, msg2 drives turn 3 — Pi drains one queued Follow-up per turn; neither dropped.)
- [x] Same-boundary message/idle arbitration and all listener, timer, signal, and socket cleanup behavior remain unchanged. (No production code changed; existing TASK-0080/0081 suites green.)
- [x] Already-idle, became-idle, offline, timeout, abort, and error paths do not gain accidental terminating behavior. (`wait-for-member-idle.test.ts` asserts `terminate` falsy for offline/became-idle; mapping `terminate: outcome === "message-received"` unchanged.)
- [x] Solitary/sequential invocation and Pi's all-results termination constraint are covered by tests and public tool guidance. Product explicitly accepts mixed-batch behavior as a characterized upstream constraint outside the supported immediate-consumption contract; this is not an unknown or a requirement for Bebop to mutate sibling results.
- [x] `docs/MEMBER-IDLE-WAIT.md` and README describe immediate consumption without claiming task completion or response correlation. (The standalone doc file was removed by `538d2a9`; the contract lives in README "consumed immediately in the next model continuation" and the tool description "Call this coordination wait alone/sequentially, never in a parallel tool batch".)
- [x] Focused tests, Bebop final gate, and unchanged-worktree freshness proof pass. (Focused 19/19 across continuation/wake/tool suites; watcher gen 306 `@agent-final` PASS: format-check, lint, arch-check, build, full suite; worktree clean of unintended production changes — `src/tools/wait-for-member-idle.ts` is byte-identical to HEAD.)

## Accepted upstream Pi constraint (product decision, 28-08)

`member-idle-continuation.integration.test.ts` test 4 pins the rule: Pi skips
the tool-result continuation only when **every** result in the batch
terminates. One `terminate: true` wait result plus a non-terminating sibling
(`bebop_noop`) still produces one ordinary content-free continuation (context
with tool results only), and the unchanged waking message is consumed exactly
once one turn later. Nothing is dropped, but immediate consumption is not
guaranteed for mixed batches.

Product explicitly accepts that residual Pi 0.84.x constraint as final for
TASK-0089. The supported contract is the solitary/sequential invocation stated
above. Mixed invocation is a caller contract violation with safe eventual FIFO
consumption, not a Bebop success claim and not a reason to rewrite delivery or
terminate unrelated work. An upstream Pi release may later broaden the
supported contract through a separate task; TASK-0089 may close without that
future API after the full payload-field provider-context criterion is evidenced
and independently accepted.

## Out of scope

- Changing `wait_for_request_outcome`.
- Reading Pi private queues or storing message content in the wake gate.
- Converting Follow-up into Redirect or changing sender-facing delivery intent.
- Treating message receipt as target idle, acknowledgement, response, or task completion.
