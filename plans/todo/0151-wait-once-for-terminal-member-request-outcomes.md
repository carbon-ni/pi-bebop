---
id: TASK-0151
title: Wait once for terminal Member Request outcomes
status: todo
depends_on: []
priority: high
tags: [member-request, requester, wait, yielding, timeout, coordination, ux]
---

# Wait once for terminal Member Request outcomes

## Problem

A Requester can be resumed while its Member Request is still pending and then
call `wait_for_request_outcome` again without new information. Slow research or
review therefore becomes a repeated wait/wake loop that consumes agent turns
and makes the Requester uncertain whether anything changed.

TASK-0144 introduced one 180-second `still-pending` requester reminder to make
slow Requests visible. In practice, that nonterminal wake creates the same
loop: the Requester has no terminal outcome to handle and usually waits again.

## Desired outcome

One `wait_for_request_outcome` call parks the Requester until the next terminal
outcome: Response, offline, timeout after idle, or max-wait timeout. A pending
Request does not wake the Requester merely to report that it remains pending.
Every accepted Request keeps its finite safeguards, so waiting cannot be
unbounded.

`send_member_request` remains nonblocking after acceptance. This preserves
parallel delegation: a Requester may send several independent Requests or do
ready work before parking. The change is to the outcome wait, not to initial
message delivery.

## Example

```text
send_member_request(Dave, "Research option A and report recommendation")
send_member_request(Kelly, "Review option B and report verdict")

# No immediate coordination work remains.
wait_for_request_outcome()

# The Requester resumes once, with the first terminal outcome.
# If another Request remains pending, one later wait parks for its terminal outcome.
```

A slow responder produces no intermediate requester turn. Existing post-idle
Response grace and absolute max-wait still produce bounded terminal timeouts.

## Acceptance criteria

- [ ] Tests first reproduce the current slow-Request behavior: the 180-second
      `still-pending` event resumes the Requester without a terminal outcome and
      leads to another outcome wait.
- [ ] `send_member_request` still returns after accepted delivery with its opaque
      Request ID; it does not block the sending tool call until Response.
- [ ] One `wait_for_request_outcome` call yields once and remains parked until the
      oldest terminal outbound Request outcome is available.
- [ ] A Request that is merely still pending never queues a requester model turn,
      resolves a parked wait, or asks the Requester to call the wait again.
- [ ] Remove the requester-side 180-second `still-pending` event, reminder timer,
      renderer output, tool result variant, and associated public vocabulary.
- [ ] Response, offline, timeout(`response-after-idle`), and
      timeout(`max-wait`) remain the only Request outcomes that resume a parked
      Requester.
- [ ] Existing post-idle grace and absolute max-wait deadlines remain finite,
      independently configurable, and first-terminal-wins; max-wait guarantees
      every accepted Request eventually settles even if the responder stays busy.
- [ ] With several outbound Requests, the first terminal outcome resumes the
      Requester and leaves other Requests pending; one subsequent wait parks for
      the next terminal outcome without duplicating listeners, timers, or turns.
- [ ] If a terminal outcome was buffered before the wait call, the wait returns
      that outcome immediately and exactly once.
- [ ] Cancellation, session clear, membership loss, endpoint loss, and shutdown
      release parked wait state and Request resources deterministically without a
      stale later resume.
- [ ] Inbound Member Requests remain responder-side and can still enter the
      Requester's session while an outbound outcome wait is parked; waiting does
      not block Crew communication or the Pi runtime thread.
- [ ] With no pending or buffered outbound Request, the tool returns the current
      normal `all-settled` success and does not create a wait.
- [ ] Tool descriptions, membership context, README, UL, workflow docs, and UI
      teach “send asynchronously, then wait once for a terminal outcome” with no
      polling or `still-pending` loop.
- [ ] Fake-clock tests cover Response before safeguards, post-idle timeout,
      max-wait timeout, exact boundary precedence, and no requester wake at the
      former 180-second reminder boundary.
- [ ] A real multi-runtime test proves a slow responder causes zero intermediate
      requester turns and exactly one terminal resume.
- [ ] Focused coverage, architecture/package checks, full gate, fresh unchanged
      watcher fingerprint, and independent exact-head QA pass.

## Constraints

- Preserve Requester/Responder roles, one correlated Response, opaque Request
  IDs, transient request channels, capacity bounds, privacy, and first-terminal
  arbitration.
- Preserve asynchronous initial sends and parallel coordination.
- Use yielding/suspension rather than holding a tool promise or blocking the Pi
  runtime thread.
- Use deterministic clocks and lifecycle signals; no polling, sleeps, or prompt
  heuristics.

## Non-goals

- Making `send_member_request` itself wait for a Response.
- Adding progress events, recurring reminders, automatic nudges, task inference,
  or durable Requests.
- Changing target-side first-idle Response reminder, post-idle grace, max-wait
  defaults, `wait_for_member_idle`, or ordinary Follow-up behavior.
- Proving that a Response is correct, complete, or verified.

## Supersedes

This task removes the requester-side nonterminal `still-pending` reminder added
by TASK-0144. It preserves TASK-0144's asynchronous send and terminal outcome
loop, but replaces repeated pending wake/re-wait behavior with one terminal wait.
