---
id: TASK-0215
title: Wait for an exact Member Request without duplicating it
status: done
depends_on: []
priority: high
tags: [crew, member-request, wait, correlation, lifecycle, tdd]
---

# Wait for an exact Member Request without duplicating it

## Problem

`send_member_request` returns an opaque Request ID, and the application/CLI already support exact-ID waiting, but the agent tool `wait_for_request_outcome` accepts no ID and waits for the oldest outbound outcome.

The short post-idle Response grace currently produces a terminal timeout and closes the Request channel. An agent that still needs the answer may then send a replacement Request, creating duplicate work instead of continuing to wait for the accepted Request it already knows.

## Desired outcome

An agent waits for one exact accepted Request by its Request ID. If the responder becomes idle and the short grace passes without a Response, the wait reports that the same Request is still pending; it does not expire the Request. The agent can wait again with the same ID until a real terminal outcome or the existing hard safety deadline.

## Product decisions

- `wait_for_request_outcome` requires `request_id`; it never guesses the sole or oldest Request.
- The Request ID returned by `send_member_request` is the stable correlation key for every later wait.
- `response-after-idle` becomes a one-shot, nonterminal `pending-after-idle` observation. It releases the current wait but preserves both source and responder Request state and the response channel.
- A second exact wait after `pending-after-idle` blocks on the same Request until Response, offline, cancellation, or hard `max-wait` expiry. The short post-idle observation does not repeat indefinitely.
- `max-wait` remains terminal and bounded. After it expires, a late Response is rejected and re-waiting returns the retained terminal result or an explicit consumed/expired state; it never silently creates a new Request.
- An accepted inbound Bebop message or local tool cancellation may release one wait call, but neither settles the Request. The next wait uses the same ID.
- Bebop does not automatically resend or clone a Request. Starting a new Request remains an explicit caller decision.

## Acceptance criteria

### Exact correlation

- [x] `wait_for_request_outcome` exposes one required bounded `request_id` parameter matching the ID returned by `send_member_request`.
- [x] A buffered terminal outcome for that exact ID returns immediately, even when older or newer Requests also exist.
- [x] An active exact Request blocks the same tool call until its next reportable outcome.
- [x] Unknown, malformed, already-consumed, expired, and concurrently-waited IDs return distinct actionable results without selecting another Request.
- [x] Multiple outbound Requests cannot cause the wait to return an outcome for a different ID.
- [x] CLI and agent-tool terminology use the same exact-ID contract; no tool retains “oldest outcome” wording.

### Re-waitable post-idle state

- [x] The responder's first valid post-context idle still arms one short grace and one reminder.
- [x] If the grace passes without a Response, the source receives `pending-after-idle` for the exact ID.
- [x] `pending-after-idle` is explicitly nonterminal: outbound/inbound registrations, capacity ownership, and the response channel remain active.
- [x] The `pending-after-idle` event is delivered at most once and cannot create an immediate-return loop on repeated exact waits.
- [x] A subsequent exact wait for the same ID can receive a later Response normally.
- [x] A Response racing the post-idle boundary wins over `pending-after-idle`; no pending notice may hide or replace a Response.
- [x] Offline and hard `max-wait` outcomes remain terminal, close resources exactly once, and are buffered for exact retrieval.
- [x] Hard expiry still bounds timers, channels, registrations, tombstones, and memory.

### Interrupted waits and duplicate avoidance

- [x] If an accepted Follow-up, Redirect, or Inbox delivery releases the wait, the result includes the exact Request ID and directs the agent to process the message, then wait again with that same ID.
- [x] Aborting or cancelling a wait removes only the waiter; it does not cancel, expire, or duplicate the Request.
- [x] Re-entering the wait after interruption attaches to the same active Request and cannot reopen a terminal one.
- [x] `send_member_request` success text teaches the copyable next action with its returned Request ID.
- [x] Pending, interrupted, and timeout messages explicitly say not to send a replacement solely because the wait ended.
- [x] No provider turn, polling loop, retry Request, or model-authored correlation guess is introduced by the runtime.

### Verification and guidance

- [x] Deterministic domain/application tests cover exact selection among multiple Requests, buffered exact outcomes, unknown/consumed IDs, one active waiter, cancellation, and wake/re-wait.
- [x] Fake-clock tests cover idle → grace → `pending-after-idle` → exact re-wait → Response, the Response/grace race, offline, hard expiry, and timer cleanup.
- [x] Real two-runtime integration proves the responder can answer the original ID after the requester receives `pending-after-idle` and re-waits.
- [x] Tool tests prove required `request_id`, actionable copy, and no oldest-request fallback.
- [x] Member Request documentation explains short nonterminal pending notice versus terminal hard expiry.
- [x] Focused tests, package verification, and final quality gate pass.

## Constraints

- Preserve one Response per Request and current identity/authority validation.
- Keep request lifecycle decisions in the domain/application layer; tools and CLI only adapt them.
- Keep deterministic first-event precedence and bounded tombstone retention.
- Do not infer correlation from member name, role, message text, order, or model context.

## Non-goals

Keeping Requests alive after hard `max-wait`, unbounded waiting, automatic resend, duplicate suppression across intentionally distinct Requests, polling, workflow completion tracking, responder progress inference, or changing ordinary Follow-up semantics.
