---
id: TASK-0144
title: Run asynchronous Request conversations with cancellable reminders
status: in-progress
depends_on: []
priority: high
tags: [member-request, reminder, async, coordination, tdd]
---

# Run asynchronous Request conversations with cancellable reminders

## Problem
Agents can send several response-required requests asynchronously, but slow requests provide no bounded requester-side reminder and an empty outcome loop ends as an error instead of completing normally.

## Outcome

Every accepted response-required send registers a one-shot trigger for the
Requester: the agent/session that sent the Request and uses
`wait_for_request_outcome`. A terminal outcome before three minutes cancels the
trigger. If the Request remains unanswered, the trigger resumes only the
Requester with a nonterminal `still-pending` reminder.

The Requester may send an ordinary Follow-up to the same Member, continue other
work, and wait again. Terminal outcomes remain correlated and are drained until
`wait_for_request_outcome` reports that all outbound Requests are settled.
Nothing is automatically sent to the target Member.

## Example loop

```text
send_member_request(Dave, "Implement A")   -> Request A + requester trigger A
send_member_request(Kelly, "Review B")     -> Request B + requester trigger B
wait_for_request_outcome()                  -> yields for next Request event

# First event wins:
# - Kelly Response: cancel trigger B and resume Requester with Response B
# - or 180s for A: resume Requester with still-pending A

send_follow_up(Dave, "Checking whether A is blocked")  # optional nudge
wait_for_request_outcome()                              # wait for next event
...
wait_for_request_outcome() -> all-settled
```

## Implementation progress

- [x] Added a pure one-shot requester reminder scheduler with fake-clock coverage at 179,999ms and 180,000ms.
- [x] Registered the scheduler at accepted delivery and cancelled it on terminal Request cleanup.
- [x] Added nonterminal `still-pending` Request events that preserve the outbound Request.
- [x] Connected reminders to requester-only yielding delivery and completed the async outcome loop; empty queues return `all-settled`.

## Contract

### Trigger and cancellation

- Register one requester reminder at accepted delivery, not when the wait tool
  is called. Deadline is exact `acceptedAt + 180_000ms`.
- Key it by existing opaque Request ID and exact resolved Member identity.
- Response, offline, Request timeout, abort, channel loss, Membership loss,
  clear, or shutdown cancels exact trigger once.
- Cancellation before deadline produces no reminder. Cancellation after timer
  but before safe model handoff tombstones queued reminder.
- Only explicit response-required tools register triggers. Today this is
  `send_member_request`. Never infer Response expectation from Follow-up,
  Redirect, Inbox, Broadcast, Presence, or Crew correspondence.

### Requester reminder

- If Request is active at 180 seconds, resolve parked
  `wait_for_request_outcome` with nonterminal `still-pending` event.
- If no outcome wait is parked, queue one bounded Requester reminder turn. When
  Requester is busy, deliver at next natural turn; never steer/interrupt it.
- Include only opaque Request ID, exact target display identity, age `180s`, and
  bounded guidance to check whether ordinary Follow-up is useful.
- Reminder does not resolve Request, create another Request, reset deadlines,
  consume capacity, or send anything to target.
- One reminder budget exists per Request. No automatic recurrence.

### Async outcome loop

- `wait_for_request_outcome` stays yielding. It never blocks model loop or
  polls.
- It waits for oldest next Request event: terminal outcome or due reminder.
- Reminder consumes only trigger and parked wait. Request remains pending, so
  next wait can receive terminal outcome.
- Return bounded `pending_count` with each event.
- With no outbound Request or buffered event, return normal `all-settled`
  success with `pending_count: 0`, not `no-pending-member-requests` error.
- Inbound Requests remain responder-side and never enter this loop.
- If another correlated answer is needed after Response, Requester sends new
  Member Request with new ID and trigger. Never auto-chain model conversation.

### Concurrent Requests

- Each accepted Request owns independent trigger and cancellation.
- Terminal B cancels only trigger B. Request A remains live.
- Reminders due in same scheduler turn batch in acceptance order, bounded by
  existing outbound capacity, and wake Requester once.
- Request IDs preserve causality when outcomes arrive out of send order.

## Acceptance criteria

- [x] Fake clock proves trigger at accepted delivery, pending at 179,999ms, and
      one Requester reminder at exact 180,000ms.
- [ ] Response, offline, Request timeout, abort, and channel loss before
      deadline cancel exact trigger and emit no reminder.
- [x] Timer-first then terminal-before-handoff discards an undelivered reminder;
      terminal remains available once.
- [ ] Reminder-after-handoff then later Response produces one reminder followed
      by one terminal outcome without loss or duplicate.
- [x] Parked wait resolves with `still-pending`; Request stays pending and next
      wait can receive terminal outcome.
- [x] Without parked wait, idle Requester gets one reminder turn and busy
      Requester gets next-turn delivery, never steer.
- [x] Two simultaneous deadlines batch deterministically and wake Requester
      once.
- [ ] Multiple-Request test proves B Response cancels only B trigger while A
      reminder/outcome remains live.
- [x] `pending_count` changes only on terminal outcomes. At zero,
      `all-settled` is success.
- [ ] Ordinary requester Follow-up after reminder does not create/replace a
      Request, reset trigger, or imply correlation.
- [ ] New Member Request after Response receives new ID and independent trigger;
      no automatic conversation loop exists.
- [ ] Shutdown/clear/abort removes timer/listener handles without leaks.
- [ ] Requester reminder crosses shared Compaction Delivery Gate; terminal
      tombstone prevents stale handoff.
- [ ] Reminder/model/UI output exposes no socket, session, manifest, callback
      route, gate, queue, timer handle, or inferred target state.
- [ ] Real multi-runtime Pi test sends at least two Requests, yields source run,
      returns early Response for one, reminds Requester for slow one, permits an
      ordinary Follow-up, returns later Response, then returns `all-settled`.
- [ ] Remove false text `respond_to_member_request requires a new request` and
      preserve clear requester/responder affordances.
- [ ] Tool descriptions, `README.md`, `docs/MEMBER-REQUEST-WORKFLOW.md`, `UL.md`,
      renderers, and package inventory teach async loop and fixed reminder.
- [ ] Focused fake-clock/real-runtime tests, typecheck, formatting, architecture
      and package checks, full suite, coverage/risk gate, and fresh watcher pass
      on one clean exact SHA.

## Constraints

- Preserve one correlated Response, first-terminal-wins, target first-idle
  reminder, post-idle grace, Request hard deadline, transient live channel, and
  yielding semantics.
- Fixed 180 seconds; no public trigger configuration in this urgent slice.
- Reminder is Requester-side coordination, not Presence, Member Status,
  progress, or durable evidence.
- No polling, test sleeps, repeated automatic nudges, automatic target message,
  inferred Response expectation, durable Request recovery, or upstream Pi
  changes.

## Risks

- Requester reminder must use the current centralized model-delivery adapter;
  this task does not reopen or wait for TASK-0140's full recovery matrix.
- Busy Requester delivery can distract from active work. Queue it for next turn
  and batch same-turn reminders.
- `all-settled` intentionally changes empty-wait API from error to success.
- pi-auto suspension must resume for reminder turn and allow new wait without
  duplicate Wait IDs.

## Non-goals

- Blocking `wait_for_request_outcome`.
- Changing `wait_for_member_idle`, Request grace, or hard-timeout defaults.
- Sending reminder to target Member.
- Creating recurring reminders or autonomous agent-to-agent loop.
- Durable Requests or operator recovery.

