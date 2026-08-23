---
id: TASK-0050
title: Define one-shot member idle waiting semantics
status: doing
depends_on: [TASK-0046]
priority: high
tags: [crew, activity, idle, waiting, lifecycle, protocol, privacy]
---

# Define one-shot member idle waiting semantics

## Problem
A coordinating crew member needs a bounded way to wait until another member Pi becomes mechanically idle, then resume and decide what to do when no reply arrived. Idle must not be confused with task completion, message acknowledgement, availability, or a correlated response.

## Context

Proposed joined-member tool:

```text
wait_for_member_idle({ member: "Bob", timeout_seconds: 300 })
```

This is one blocking, event-driven wait. It keeps caller tool execution pending without making repeated model calls. Caller resumes with bounded result when target is already idle, becomes idle, goes offline, timeout expires, or caller cancels.

Use case may be lead coordination, but roles are descriptive rather than permissions: any joined member may wait for another configured member. Self, unjoined, unknown, and ambiguous targets are rejected.

Idle uses TASK-0046 mechanical meaning: Pi runtime settled after active agent run, retry, compaction retry, and queued continuation. It does **not** prove target saw a particular message, finished task, intends to reply, is healthy/productive/available, or will remain idle. `send_follow_up(wait_for: "response")` remains unsupported until delivery-level response correlation can be proven; idle waiting must not approximate it.

## Proposed outcome

```json
{
  "member": { "name": "Bob", "role": "developer" },
  "outcome": "idle",
  "disposition": "became-idle",
  "observedAt": "2026-08-23T12:03:00.000Z"
}
```

Outcomes:

- `idle` with `already-idle` or `became-idle` disposition;
- `offline` when endpoint is unreachable before/during wait;
- `timeout` when bounded deadline expires while target remains busy;
- cancellation uses normal aborted tool result and releases subscription.

Default timeout: 300 seconds. Allowed range: 1–600 seconds. Timeout is expected coordination outcome, not task failure.

## Lifecycle and race contract

1. Resolve exact configured target through current membership.
2. Open one-shot target subscription.
3. Target atomically registers subscription and snapshots current `ctx.isIdle()` so idle transition cannot be lost between separate check/subscribe calls.
4. If already idle, complete immediately. Otherwise emit once from `agent_settled` only after retry/compaction/queued continuations are exhausted.
5. Target disconnect/restart completes as offline; timeout/caller cancellation removes subscription.

Wait is transient and non-durable. It creates no chat activity, Focus, history, dashboard, background polling, or automatic follow-up. Target enforces finite subscription capacity and rejects overflow explicitly.

## Acceptance criteria

- [x] Ubiquitous language defines **Member Idle Wait** as one-shot coordination primitive, distinct from response waiting, Member Status query, continuous monitoring, Presence, and availability.
- [x] Any current joined member may wait for another exact configured member; roles grant no extra authority.
- [x] Unjoined, self, unknown, and ambiguous targets reject before network IO.
- [x] Offline target returns immediately; endpoint going offline/restarting during wait completes as offline rather than hanging or silently resubscribing.
- [x] Already-idle target returns `idle/already-idle` without registering lingering subscription.
- [x] Busy target completes only at Pi `agent_settled`, returning `idle/became-idle`; `agent_end` alone is insufficient while retry, compaction, or queued continuation remains.
- [x] Subscribe-and-snapshot ordering prevents lost-idle race and exactly one terminal outcome wins against timeout, disconnect, settle, and cancellation.
- [x] Timeout is required to be finite: default 300 seconds, accepted range 1–600 seconds, deterministic expected `timeout` outcome.
- [x] Caller cancellation releases local connection and remote subscription promptly.
- [x] Result contains only configured name/role, terminal outcome/disposition, and observation timestamp; no messages, Focus, prompts, tools, session ids, aliases, paths, model data, or instructions.
- [x] Idle is documented as mechanical momentary state, never message acknowledgement, response correlation, task completion, availability, or promise to remain idle.
- [x] Wait never starts, steers, interrupts, aborts, or sends guidance to target turn.
- [x] Subscription is transient/non-durable, one-shot, capacity-bounded, and leak-free across success, timeout, cancellation, disconnect, reload, and shutdown.
- [x] Domain schema/state-race tests cover already idle, busy→settled, queued continuation, offline, timeout, cancellation, duplicate terminal events, and privacy exclusions.

## Out of scope

- Waiting for a reply, task completion, Focus change, online transition, arbitrary status predicate, multiple members, external actors, persistent/background watches, monitoring dashboards, SLA/escalation policy, automatic redirect/interrupt/follow-up, or conversation inspection.

