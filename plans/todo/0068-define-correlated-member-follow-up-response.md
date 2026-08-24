---
id: TASK-0068
title: Define correlated crew-update coordination loop
status: todo
depends_on: []
priority: high
tags: [crew, messaging, response, correlation, orchestration, protocol, product]
---

# Define correlated crew-update coordination loop

## Problem

A lead keeps coordination moving with “wait for member idle or continue.” Idle
can release after a member has already queued a reply for the lead's next Pi
run, so the lead continues without seeing it. Blocking inside the original send
would avoid that race but would prevent the lead from delegating to and handling
other members concurrently.

## Context

Separate request creation from event consumption:

1. `send_follow_up` optionally registers an expected reply and returns
   immediately with `requestId` after accepted delivery.
2. Lead continues assigning and coordinating other work.
3. `wait_for_crew_update` blocks once for the first terminal update among all
   active requests.
4. Lead handles that update and repeats until no delegated or ready work remains.

Proposed request syntax:

```text
send_follow_up({
  member: "Bob",
  message: "Implement TASK-123 and report evidence or blocker.",
  expect_reply: true,
  response_timeout_seconds: 300
})
```

Proposed loop tool:

```text
wait_for_crew_update()
```

Closed update outcomes:

- `response` — correlated response content from expected member;
- `idle-without-response` — request message ran and target settled without
  sending correlated response;
- `offline` — target request channel disconnected before response;
- `timeout` — request deadline expired;
- caller cancellation aborts only current wait, not accepted assignments or
  other pending requests.

Target request transport stays open after accepted delivery and owns lifecycle.
The target receives an opaque `requestId` in structured context. It answers with
ordinary `send_follow_up({ member: <requester>, in_reply_to: <requestId>, ... })`.
`in_reply_to` resolves only through target-local active request state; responder
cannot supply requester session/socket/manifest paths.

The correlated response travels over request channel and is stored as one
bounded source-side update. It is returned once by `wait_for_crew_update` and is
not also placed in Pi follow-up queue. Unrelated messages preserve normal Pi
FIFO behavior. If response and idle settle in same lifecycle boundary,
`response` wins deterministically.

## Acceptance criteria

- [ ] `send_follow_up` keeps current default accepted-delivery behavior byte/semantically compatible when `expect_reply` is absent/false.
- [ ] `expect_reply: true` registers target request channel before handing message to Pi, uses finite `response_timeout_seconds` default 300/range 1–600, and returns accepted result plus opaque bounded `requestId` without blocking lead.
- [ ] `wait_for_crew_update` has no member argument by default and returns first terminal update across all current session requests; `no-pending-requests` fails immediately with instruction to delegate or stop.
- [ ] Updates are ordered by terminal event acceptance sequence with request id as deterministic tie-breaker; multiple members and multiple requests per member may resolve out of assignment order.
- [ ] Request becomes eligible for `idle-without-response` only after its message entered target model context; target's pre-delivery idle snapshot cannot satisfy it.
- [ ] Matching response closes request before target settled handling, so response wins same-boundary response-versus-idle race; exactly one terminal update exists per request.
- [ ] Response update contains configured member identity, request id, bounded response content and ordered instructions; idle/offline/timeout contain no message content.
- [ ] `in_reply_to` is accepted only by `send_follow_up` to exact stored requester of one active inbound request; Redirect, Inbox, Broadcast, Interrupt, and arbitrary target never accept it.
- [ ] Target membership derives responder origin and active request derives return channel; no caller-selected origin, session id, alias, socket, manifest, or trust claim crosses public tool schema.
- [ ] Wrong member/target, unknown/expired id, malformed payload, replay, and duplicate response return stable errors and cannot consume another request.
- [ ] Late reply returns `response-expired` plus recovery instruction to resend as ordinary Follow-up without `in_reply_to`; it is never silently lost or automatically duplicated.
- [ ] Caller cancellation of `wait_for_crew_update` releases only that waiter; pending request events remain consumable until their own deadlines. Session reload/shutdown closes channels and clears bounded transient state.
- [ ] Capacity limits are named for active inbound requests, active outbound requests, and buffered terminal updates; overflow rejects before delivery rather than dropping an existing request/update.
- [ ] Result language says response received, never task completed/correct/verified; idle remains mechanical and never substitutes for response.
- [ ] No polling, sleeps, global Pi pending-message inspection, private queue mutation, conversation scan, or automatic task tracking is introduced.
- [ ] Standalone CLI parity and durable/offline response waiting remain separate future product slices.
- [ ] `docs/CORRELATED-CREW-UPDATE-WORKFLOW.md` contains exact lead loop instruction, happy path, idle-without-response recovery, parallel-member example, stop condition, and current availability status.

## Out of scope

- Streaming/multiple responses, durable cross-restart requests, external actors,
  completion verification, automatic reassignment/escalation, or changing
  `wait_for_member_idle` semantics.

## Verification

- Approve protocol/state race table, privacy boundary, capacities, errors, and
  workflow before TASK-0071 implementation starts.
- Implementation tests use deterministic event barriers, never wall-clock sleeps.
