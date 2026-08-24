---
id: TASK-0068
title: Yield idle wait to queued caller messages
status: todo
depends_on: []
priority: high
tags: [crew, idle, messaging, lifecycle, pi-api, tdd]
---

# Yield idle wait to queued caller messages

## Problem
A lead blocked in wait_for_member_idle can observe a member settle after that member has queued a reply, but the reply is not visible until the lead's next Pi run. The lead's current run may continue from the idle result and incorrectly conclude that no response arrived.

## Context

This is a caller-side turn-boundary race, not a target idle-detection bug.
`send_follow_up` can be durably accepted into the lead's Pi follow-up queue
before the target emits `agent_settled`, while the lead's current model call
cannot see that queued message until its current run ends.

Pi 0.84.2 provides the two required deterministic primitives to custom tools:

- tool execution receives the current `ExtensionContext`, whose
  `hasPendingMessages()` reports queued steering/follow-up work;
- a tool result may return `terminate: true`, which skips the automatic
  post-tool model call when every result in that tool batch terminates. Pi can
  then process the already-queued continuation.

After the remote wait reaches any successful terminal outcome, sample the
caller's current `ctx.hasPendingMessages()`. If true, return the ordinary wait
result plus caller-side handoff metadata and `terminate: true`. Do not inspect,
consume, reorder, copy, or correlate message content. Keep the member idle
protocol and pure domain result unchanged: queued caller work is Pi runtime
metadata owned by the tool adapter.

Because Pi applies termination only when every result in a parallel tool batch
terminates, tool guidance must require `wait_for_member_idle` to be called as
the sole tool in its batch. The result text remains a safe fallback: when
pending work is observed it forbids drawing a conclusion from the wait result
and directs the agent to end the current run. Do not simulate a barrier with a
time delay.

## Acceptance criteria

- [ ] Tests first reproduce the race: the target's reply is accepted into the caller's follow-up queue before target `agent_settled`, the wait returns, and no extra unqueued model continuation runs before the reply becomes the next continuation.
- [ ] `wait_for_member_idle` samples `ctx.hasPendingMessages()` exactly once after a successful `idle`, `offline`, or `timeout` result and never uses a captured/stale extension context.
- [ ] When the snapshot is true, tool details retain the unchanged member wait result and add `callerPendingMessages: true` plus `nextAction: "yield"`; the tool returns `terminate: true`.
- [ ] Pending-result text is bounded and states that queued caller messages are not visible in the current model turn, so the agent must end the run without inferring reply absence, task completion, or target intent.
- [ ] When the snapshot is false, details add `callerPendingMessages: false` plus `nextAction: "continue"`, no `terminate` field is returned, and existing idle/offline/timeout text and behavior remain compatible.
- [ ] Error, abort, malformed response, and capacity rejection paths do not claim a successful handoff and retain existing cleanup/error semantics.
- [ ] The tool reads only the caller-side pending boolean; it never reads, consumes, exposes, reorders, or filters message content, sender identity, prompts, or conversation entries.
- [ ] No sleep, grace interval, polling loop, reply inference, message correlation, target protocol field, or domain idle-state change is introduced.
- [ ] Tool description/prompt guidance requires calling `wait_for_member_idle` as the sole tool in its batch and explains that Pi only honors termination when every result in a parallel batch terminates.
- [ ] Deterministic tests cover pending and non-pending snapshots for idle, pending timeout/offline, pending arrival before settled, cancellation, and the documented parallel-batch fallback.
- [ ] A Pi lifecycle integration test proves `terminate: true` skips the ordinary post-tool model call and lets an already-queued follow-up drive the next run; the test uses event/barrier control rather than wall-clock sleeps.
- [ ] Standalone CLI idle-wait semantics in TASK-0067 remain unchanged because a CLI invocation has no active caller model turn to yield.

## Out of scope

- Correlated request/reply, reading reply content, proving that a message came
  from the waited member, changing `send_follow_up`, or treating idle as task
  completion.

## Verification

- Run focused tool, idle-flow, RPC subscription, and Pi lifecycle integration tests.
- Inspect touched-code coverage for the pending/non-pending and termination branches.
- Run a fresh final watcher gate with an unchanged worktree fingerprint.

