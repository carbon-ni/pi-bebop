---
id: TASK-0163
title: Add Member Request and Response CLI parity
status: doing
depends_on: [TASK-0154]
priority: high
tags: [cli, member-request, response, correlation, rpc, automation, axi, tdd]
---

# Add Member Request and Response CLI parity

## Problem

Correlated Member Request/Response exists only as Pi tools, so shell callers and
automation cannot deterministically send a request, discover its opaque ID,
wait for its exact terminal outcome, or submit the one correlated response
through an already-joined session.

## Desired outcome

Expose complete request lifecycle under one explicit CLI namespace while
preserving existing transient, session-owned correlation semantics:

```text
pi-bebop member request send <member> [--session <id|alias>] \
  (--message <text> | --stdin) [--instruction <text>...] \
  [--response-grace <duration>] [--max-wait <duration>] \
  [--format toon|json|text]

pi-bebop member request list [--session <id|alias>] \
  [--direction inbound|outbound|all] [--format toon|json|text]

pi-bebop member request wait <request-id> [--session <id|alias>] \
  [--format toon|json|text]

pi-bebop member request respond <request-id> [--session <id|alias>] \
  (--message <text> | --stdin) [--instruction <text>...] \
  [--format toon|json|text]
```

Explicit `send`, `wait`, and `respond` verbs match effect-bearing
`member inbox send` precedent. CLI always requires exact Request ID for wait
and respond; it never guesses sole/oldest request. Tool convenience remains
unchanged: `respond_to_member_request` may select sole inbound request and
`wait_for_request_outcome` may consume oldest terminal outcome.

## Result contract

- `send`: returns `accepted`, exact configured Member identity, opaque Request
  ID, response grace, and absolute max-wait deadline. It never says responded,
  assigned, completed, or correct.
- `list`: bounded deterministic metadata only: direction, Request ID,
  counterpart name/role, lifecycle state, and remaining deadline where known.
  It never exposes message/instruction content, response channel, or socket.
- `wait`: blocks for exact outbound Request and returns one terminal outcome:
  `response`, `idle-without-response`, `offline`, or `timeout`. Buffered outcome
  returns immediately. Cancellation stops only CLI waiter and preserves Request.
- `respond`: resolves requester/channel only from exact active inbound Request,
  sends one Response, and returns `response-accepted`. It never claims requester
  received, read, or acted on response.

A terminal outcome is consumable once across tool and CLI waiters. Competing
waiters use atomic first-consumer-wins semantics; loser receives
`outcome-consumed`, never a duplicate or different Request outcome.

## Acceptance criteria

- [ ] TDD starts with send/list/wait/respond happy paths plus invalid source,
      wrong direction, unknown/expired/consumed ID, offline, idle, timeout,
      cancellation, response race, duplicate response, and concurrent waiters.
- [ ] New commands use existing declarative Commander registry and one command
      adapter per leaf; no bespoke root parser or copied dispatch chain.
- [ ] All commands select one existing joined source through leaf-local
      `--session`, then `PI_SESSION_ID`; CLI never loads manifest or accepts
      caller-claimed Member/Origin/socket/reply fields.
- [ ] `send` reuses exact Member resolution and register-before-delivery
      semantics of `send_member_request`; accepted request remains alive in
      selected Pi source after CLI process exits.
- [ ] `--response-grace` uses current post-idle Response grace grammar/default
      (120s, range 1–600s). `--max-wait` uses current absolute safeguard
      grammar/default (30m, range 60s–2h) and must be strictly greater.
- [ ] Request ID is emitted in every request-specific result/error and remains
      opaque; callers never construct or override IDs.
- [ ] `list` defaults to `all`, preserves lifecycle acceptance order with Request
      ID tie-breaker, is bounded, reports omitted count, and excludes content,
      instructions, capabilities, session aliases, sockets, and manifest paths.
- [ ] `wait` requires exact outbound Request ID, returns already-buffered result
      immediately, otherwise waits without polling, and cannot consume another
      Request's outcome.
- [ ] CLI wait cancellation/disconnect releases only that waiter. Active Request
      and buffered terminal outcome remain available to later exact/tool wait.
- [ ] At most one consumer receives terminal outcome. Exact CLI wait and oldest
      tool wait arbitrate atomically; duplicate wait returns stable
      `outcome-consumed` or `already-waiting` as appropriate.
- [ ] `respond` requires exact inbound Request ID even when only one exists,
      preserves ordered instructions, and derives requester/return channel from
      source runtime only.
- [ ] Response, target idle, offline, and timeout retain existing precedence;
      response wins same-settled idle boundary and late reply returns
      `response-expired` with Follow-up recovery.
- [ ] TOON default and JSON/text opt-ins use stable discriminated schemas.
      Terminal expected outcomes exit 0; usage errors exit 2; operational,
      unknown, expired, consumed, or delivery failures exit 1.
- [ ] SIGINT/SIGTERM and client disconnect clean up listeners/transports once
      without cancelling accepted Request or manufacturing timeout/offline.
- [ ] Root/home and leaf help explain send→wait and inbound→respond flows,
      distinguish Follow-up, and use copyable recovery commands.
- [ ] Existing three tool contracts and all current CLI commands remain
      regression-covered; no tool behavior or vocabulary changes.
- [ ] Real two-runtime test sends via CLI, lists both sides, responds via CLI,
      waits exact ID, proves Response appears once, then covers idle/offline and
      waiter cancellation without sleeps.
- [ ] CLI coverage/complexity, protocol validation, package smoke, architecture,
      full watcher, and independent exact-head QA gates pass.

## Constraints

- Reuse `MemberRequestFlow` and `RequestOutcomeRegistry`; extend them with exact,
  bounded observation/consumption rather than creating a second CLI registry.
- Request remains transient and owned by running joined source session. Restart
  closes it under existing semantics; CLI does not add persistence.
- Waiting is event-driven with bounded semantic deadlines; never poll or sleep.
- Keep request content out of list/status output and credentials/routes out of
  every public result.

## Non-goals

- Durable/offline requests, multiple or streaming Responses, request
  cancellation/retraction, automatic retry/reassignment, cross-session
  migration, external/Guest requests, task completion claims, or changes to
  Follow-up, Redirect, Inbox, Broadcast, and Member Idle Wait semantics.
