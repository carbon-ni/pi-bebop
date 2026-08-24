---
id: TASK-0068
title: Define correlated crew-update coordination loop
status: done
depends_on: []
priority: high
tags: [crew, messaging, response, correlation, orchestration, protocol, product]
---

# Define correlated crew-update coordination loop

## Problem

A lead currently needs detailed behavioral instructions to combine Follow-up,
idle waiting, pending messages, and continuation correctly. That makes safe
coordination depend on model remembering protocol mechanics. Blocking inside a
send also prevents lead from coordinating several members concurrently.

## Context

Make intended workflow obvious through three dedicated tools with safe defaults:

```text
request_member({ member, message, instructions?, timeout_seconds? })
respond_to_member_request({ message, instructions?, request_id? })
wait_for_crew_update()
```

`request_member` means “send normal non-interrupting request and expect exactly
one response.” It registers request before delivery, defaults timeout to 300
seconds (range 1–600), and returns accepted request id immediately. Ordinary
`send_follow_up` remains accepted-delivery messaging with no hidden response
expectation.

`respond_to_member_request` derives requester and return channel from active
inbound request. With exactly one active request it selects it by default; with
zero it errors with ordinary Follow-up recovery, and with multiple it requires
explicit bounded `request_id`.

`wait_for_crew_update` needs no arguments. It returns first terminal update
across current session requests. If none exist, it fails immediately with
`no-pending-requests` and tells agent to continue ready work or stop.

Closed outcomes:

- `response` — correlated response content from expected member;
- `idle-without-response` — request entered target model context and target
  settled without correlated response;
- `offline` — target request channel disconnected before response;
- `timeout` — request deadline expired.

Target request transport remains open after accepted delivery and owns
lifecycle. Response travels over that channel, is buffered once at requester,
and is returned once through `wait_for_crew_update`; it is not duplicated into
Pi Follow-up queue. Unrelated messages preserve Pi FIFO behavior. Response wins
a same-boundary response/idle race.

Tools own mechanics through descriptions, prompt snippets, guidelines, defaults,
and self-correcting errors. Lead role instruction should only express intent:

> Continue coordinating until no ready work or pending crew requests remain.

## Acceptance criteria

- [ ] Dedicated tool names and descriptions make request, response, and next-update waiting distinct from ordinary Follow-up, Redirect, Inbox, Status, and Member Idle Wait.
- [ ] `request_member` requires only member/message, defaults instructions empty and timeout 300 seconds, registers before delivery, and returns accepted configured identity plus opaque bounded request id without blocking.
- [ ] `respond_to_member_request` requires only message when exactly one inbound request is active; zero returns `no-pending-request` with `send_follow_up` recovery, while multiple returns `ambiguous-request` with bounded request ids/requesters and requires explicit `request_id`.
- [ ] `wait_for_crew_update` takes no required input, returns oldest accepted terminal update across all requests, and returns `no-pending-requests` immediately instead of polling when registry empty.
- [ ] Tool prompt guidelines teach: use `request_member` when response is required; use ordinary `send_follow_up` for information not requiring response; use `respond_to_member_request` for request context; use `wait_for_crew_update` only when no immediate coordination action remains.
- [ ] Request becomes eligible for idle outcome only after request message enters target model context; pre-delivery idle cannot satisfy it.
- [ ] Response closes request before settled handling, so response wins same-boundary response/idle; exactly one terminal update exists per request.
- [ ] Updates are ordered by terminal acceptance sequence with request id deterministic tie-breaker; multiple members and requests may resolve out of assignment order.
- [ ] Response contains configured member, request id, bounded message/instructions; idle/offline/timeout contain no message content.
- [ ] Responder membership derives origin and active request derives return channel; public schemas expose no origin claim, session id, alias, socket, manifest, or trust override.
- [ ] Wrong requester/member, unknown/expired id, malformed payload, replay, and duplicate response return stable errors and cannot consume another request.
- [ ] Late response returns `response-expired` with recovery to resend as ordinary `send_follow_up`; it is never silently lost or automatically duplicated.
- [ ] Wait cancellation releases only current waiter; requests/updates remain until their own terminal lifecycle. Reload/shutdown closes transient request channels and clears bounded state.
- [ ] Named capacities bound inbound requests, outbound requests, and buffered updates; overflow rejects new request before delivery rather than dropping existing state.
- [ ] Result wording says response received, never completed/correct/verified; idle remains mechanical and never substitutes for response.
- [ ] No polling, sleep, global pending-message inspection, private Pi queue mutation, conversation scan, task tracking, or role permission is introduced.
- [ ] Existing eight-tool CLI parity remains scoped to tools approved by TASK-0060; new coordination tools are tool-only until separate CLI product decision.
- [ ] Workflow documentation leads with one-sentence loop intent and treats detailed syntax/recovery as tool-owned reference, not required lead prompt.

## Out of scope

- Multiple/streaming responses, durable cross-restart requests, external actors,
  task verification, automatic reassignment/escalation, CLI parity, or changing
  `wait_for_member_idle`.

## Approved contract decisions

The coordination contract additionally fixes these bounds and race semantics:

- Capacities are 8 outbound requests, 8 inbound requests, and 64 buffered
  terminal updates; request IDs are capped at 128 bytes (UTF-8).
- Exactly one `wait_for_crew_update` waiter may be active per source session;
  another waiter fails immediately with `already-waiting`.
- The 300-second deadline starts before dispatch and covers delivery plus the
  correlated response lifecycle.
- A pre-accept failure cleans up both source and target state. If delivery is
  accepted but its acknowledgement is lost, the result is `outcome-unknown`
  and the request channel closes.
- A response wins a same-settled idle race. Otherwise the first atomic terminal
  transition wins; idle closes the request, and a later reply returns
  `response-expired` with recovery to ordinary `send_follow_up`.

## Verification

- Approve tool vocabulary, defaults, state race table, privacy, capacities,
  errors, and minimal lead instruction before TASK-0071.
