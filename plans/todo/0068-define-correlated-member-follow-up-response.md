---
id: TASK-0068
title: Define correlated member Follow-up response
status: todo
depends_on: []
priority: high
tags: [crew, messaging, response, correlation, protocol, lifecycle, product]
---

# Define correlated member Follow-up response

## Problem

A coordinator sends work with `send_follow_up`, then uses member idle as a proxy
for completion or response. A response can already be queued for the
coordinator's next Pi run when idle releases, so the current run continues
without seeing it. Idle cannot prove a reply, and caller-side queue inspection
cannot identify which request a message answers.

## Context

Make the existing dormant `send_follow_up(wait_for: "response")` contract real
through explicit request/reply correlation. One tool call atomically registers a
bounded pending request before dispatch, sends the normal Follow-up, and blocks
until the selected member returns one correlated response, the deadline
expires, or the caller cancels.

The recipient sees an opaque `requestId` in structured member-message context.
To answer, it calls the existing `send_follow_up` back to the requester with an
explicit optional `in_reply_to: <requestId>`. The responder's active membership
derives origin and the stored inbound request derives the callback route;
callers never provide a socket, session id, manifest path, or claimed responder
identity.

A valid response is consumed at Bebop's correlation boundary and returned as
the original waiting tool result. It is not also queued into Pi, so the
coordinator sees it exactly once. Unrelated Follow-ups retain normal Pi FIFO
behavior. `wait_for_member_idle`, `get_member_status`, Redirect, durable Inbox,
and Broadcast remain separate and cannot satisfy a response wait.

Origin remains the existing locally trusted, membership-derived crew
attribution—not cryptographic authentication. Correlation proves that the
response used the issued capability and expected member route; it does not
prove task completion or truthfulness.

## Acceptance criteria

- [ ] `send_follow_up` keeps default/`accepted` behavior unchanged and supports `wait_for: "response"` as one atomic register-before-dispatch operation.
- [ ] A response wait has a generated opaque request id, exact expected configured member identity, requester callback route, creation point, and finite deadline; request id is unguessable enough for local capability use and bounded on wire.
- [ ] The recipient receives only opaque request id plus honest reply instructions in structured context; UI/rendering hides callback session/socket routes.
- [ ] `send_follow_up` accepts optional `in_reply_to` only when sending to the stored requester for that exact inbound request; normal sends omit it and Redirect never accepts it.
- [ ] Responder membership derives origin and stored request state derives destination; request parameters cannot claim source identity, callback session/socket, manifest, or project trust.
- [ ] The requester registers before dispatch so an immediate response cannot be lost; exactly one of response, timeout, cancellation, source/target disconnect, or remote rejection wins.
- [ ] A matching response from expected member is returned directly in waiting tool details/content and is not also handed to Pi's steering/follow-up queue.
- [ ] Wrong member, wrong requester target, unknown/expired request id, malformed/oversized payload, duplicate response, and replay are rejected with stable bounded codes and do not consume the live request.
- [ ] Timeout defaults to 300 seconds with accepted range 1–600 seconds; timeout/cancellation removes request state exactly once but never retracts already accepted work.
- [ ] A late response receives `response-expired` plus a copyable recovery instruction to resend as an ordinary `send_follow_up` without `in_reply_to`; it is never silently discarded or automatically duplicated.
- [ ] Result wording distinguishes `accepted` from `responded`; a correlated response proves only receipt of response payload, never task completion, availability, correctness, or future idleness.
- [ ] Multiple concurrent requests to same member remain distinct by request id and may resolve out of order; unrelated member messages cannot satisfy either wait.
- [ ] Pending request/inbound reply-route state is transient, request-scoped, capacity-bounded, and cleared on response, timeout, cancellation, disconnect, reload, and shutdown.
- [ ] No polling, grace sleep, conversation scan, global pending-message inspection, idle inference, or selective mutation of Pi's private queue is introduced.
- [ ] Tool schema/help explains when to use `wait_for: "accepted"` versus `"response"` and how responder uses `in_reply_to`; default remains normal accepted Follow-up.
- [ ] Standalone CLI remains accepted-delivery-only in this task; CLI response waiting requires a separate product slice and must not be implied by TASK-0060 documentation.

## Out of scope

- Task-completion verification, multiple responses/streaming progress, automatic
  reply selection, Redirect response waiting, durable/offline response waits,
  cross-restart recovery, or changing Member Idle Wait.

## Verification

- Review protocol shapes, capability/privacy boundary, error/exit semantics, and
  lifecycle race table before implementation.
- Ensure TASK-0071 tests every terminal race with deterministic barriers rather
  than wall-clock sleeps.
