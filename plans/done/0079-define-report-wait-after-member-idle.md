---
id: TASK-0079
title: Define Response wait after Member idle
status: done
depends_on: []
priority: high
tags: [member-request, response, idle, timeout, auto, lifecycle, product]
---

# Define Response wait after Member idle

## Problem

A Member request must wait for its correlated Response while the target works.
Mechanical idle is not itself a Request outcome: first idle after processing
should give the responder a short bounded chance to report. A separate longer
safety deadline must still release a request whose target never settles.

Agent-facing waits also yield while `/auto "wait or continue"` remains active.
Bebop and pi-auto must cooperate so auto pauses while a wait is parked and
continues only after the exact resumed outcome turn settles. Repeating the same
auto instruction before the outcome is incorrect.

## Approved product contract

### 1. Separate primitives

**Member request** waits for exactly one correlated Response:

```text
send_member_request({
  member,
  message,
  instructions?,
  timeout_seconds?: 120,
  max_wait_seconds?: 1800
})
```

- `timeout_seconds`: post-idle Response grace, integer 1–600, default 120.
- `max_wait_seconds`: absolute accepted-request safety, integer 60–7200,
  default 1800, and strictly greater than `timeout_seconds`.
- The earlier absolute deadline wins; hard safety may truncate grace when
  first idle occurs late in the accepted-request lifetime.

**Member Idle Wait** remains purely mechanical:

- already idle → immediate `already-idle`;
- later settled → `became-idle`;
- endpoint loss → `offline`;
- bounded safeguard → `timeout`, default 300 seconds/range 1–600.

Member Idle Wait never waits for Response, sends a responder reminder, reads
Request state, or infers completion/availability.

### 2. Request state machine

```text
registered
  ├─ acceptance failure/5s expiry → no accepted request
  └─ accepted → accepted-working

accepted-working
  ├─ Response → response
  ├─ offline → offline
  ├─ hard expiry → timeout(max-wait)
  └─ first valid post-context idle → idle-awaiting-response

idle-awaiting-response
  ├─ Response → response
  ├─ offline → offline
  ├─ grace expiry → timeout(response-after-idle)
  └─ hard expiry → timeout(max-wait)
```

`idle-awaiting-response` is nonterminal. It preserves the request, channel, and
capacity slot. `idle-without-response` is removed from public terminal outcomes.

### 3. Timers and ownership

- `MEMBER_REQUEST_ACCEPT_DEADLINE_MS = 5000` is an exported constant. It starts
  at dispatch and covers connect/acknowledgement only. Failure leaves no
  accepted slot and starts neither Response timer.
- Hard safety starts exactly once at source when accepted delivery is
  acknowledged: `acceptedAt + max_wait_seconds`.
- Grace starts exactly once at source when first valid internal Request-idle
  notification arrives: `idleAt + timeout_seconds`.
- Later busy/idle transitions never pause, reset, or extend either timer.
- Source/requester owns hard/grace timers and outbound state. Target/responder
  owns inbound channel and reminder-once state; target owns no Response clock.
- A terminal claim synchronously clears source timers/outbound slot and closes
  target channel/inbound/reminder state exactly once. Shutdown closes remaining
  transient state; no cross-restart recovery is claimed.

### 4. First idle and responder reminder

Pre-request/already-idle snapshots never count. Only first `agent_settled` after
Request message entered target model context emits internal RPC notification:

```text
member.request.idle { requestId, member }
```

It is internal, nonterminal, and nonresuming: no Pi/session/model message, no
public outcome, no parked-wait consumption, and no requester turn. Source uses
it only to arm grace once.

At that same first idle, target makes exactly one best-effort reminder attempt:

- one normal noninterrupting `pi.sendMessage` Follow-up with `triggerTurn:true`;
- structured Member-request guidance carrying original Request ID only;
- no callback/socket/session/manifest route and no new inbound Request slot;
- tells responder to use `respond_to_member_request`;
- never claims failure, completion, correctness, or intent;
- queues behind busy work and starts a turn when target is idle;
- no retry. Failure is bounded internal diagnostic only and never resolves or
  fails Request; timers remain authoritative.

TERMINAL-BEFORE-DELIVERY INERT RULE: if any terminal (response, offline,
grace, hard) is claimed before reminder delivery, target invalidates its
reminder-once state. A reminder not yet accepted by Pi is dropped. A reminder
already accepted into Pi FIFO is never inspected, removed, or reordered: it
may still enter context, but the terminal tombstone makes any attempted
Response return stable `no-active-request` and it cannot change Request state.
Thus a reminder is actionable only while Request is `idle-awaiting-response`;
a late in-flight reminder is explicitly stale guidance, not a new Request.

### 5. Terminal outcomes and precedence

Public outcome union:

```text
{ kind: "response", requestId, member, message, instructions }
{ kind: "offline", requestId, member }
{ kind: "timeout", requestId, member, reason: "response-after-idle" }
{ kind: "timeout", requestId, member, reason: "max-wait" }
```

Same synchronous-handler priority:

```text
response > offline > grace-expiry > hard-expiry > idle-signal
```

A complete Response beats subsequent socket close/offline in the same handler.
Otherwise first atomic terminal claim wins. Between distinct timer callbacks,
the earlier absolute deadline wins; exact grace/hard tie resolves as
`response-after-idle` because it is the more specific outcome. Hard safety is
absolute and may truncate late-started grace.

Human wording distinguishes timeout reasons but never infers task outcome.

### 6. Parked waits

`MAX_YIELDING_WAITS = 16` is exported. Overflow returns stable `capacity`.
Identity is `(current session, wait kind, target/request)`.

A semantic duplicate returns existing Wait ID and existing parked state. It
opens no socket/timer and publishes no new shared event. Cancel then re-park
creates new Wait ID.

Agent wait tool returns immediately. When it is the sole tool result it returns
`terminate:true`; in parallel batches it still never holds execution promise
open. Terminal delivery later wakes requester through one structured
`crew-wait-resume` Follow-up with `triggerTurn:true`.

### 7. Bebop ↔ pi-auto event contract

Bebop optionally publishes exactly these fire-and-forget shared events:

```text
pi-bebop:wait-parked
pi-bebop:wait-resume-queued
pi-bebop:wait-resume-started
pi-bebop:wait-resume-settled
pi-bebop:wait-cancelled
```

Payload is only `{ waitId, kind }`. No member, message, prompt, socket, session,
manifest, or route. Listeners ignore other event names, malformed payloads, and
unknown Wait IDs. Shared events are process-local coordination, not an
authentication boundary: an extension able to publish an exact Bebop event
name with a live opaque Wait ID cannot be distinguished by this schema. Bebop
behavior is identical with zero listeners.

Event sequence:

1. First park → `wait-parked`.
2. Terminal outcome is accepted and resume message is queued →
   `wait-resume-queued`. Wait remains suspended.
3. Bebop observes that exact `crew-wait-resume` message enter model context →
   `wait-resume-started`.
4. On `agent_settled` for that exact outcome turn → `wait-resume-settled`.
5. Cancellation before terminal → `wait-cancelled`; no resume message.

Timeout is a normal terminal Request/Idle outcome and follows queued → started →
settled. There is no separate wait-expired event. Semantic duplicate park emits
no rearmed event.

If several resume messages enter one outcome turn, Bebop emits started and
settled once for each Wait ID.

### 8. Auto-loop behavior

pi-auto passively tracks TWO disjoint sets of Bebop Wait IDs:

- `live` — parked or resume-queued (outcome not yet started): `wait-parked`
  adds (preserving the message and remaining count after the current
  iteration, consuming no additional iteration); `wait-resume-queued` keeps
  the id live (still pausing, because the resume has not entered context);
  `wait-resume-started` moves the id `live -> outcome-pending`;
  `wait-cancelled` removes the id immediately.
- `outcome-pending` — resume-started (resume entered model context, outcome
  turn running, Wait ID bound to that exact turn): `wait-resume-settled` of
  that exact bound turn removes the id and marks it settled.

CANCEL CONTINUATION: `wait-cancelled` removes the id from `live` immediately
through the ordinary idle/send-pending gate. A cancelled wait has NO outcome
turn, so it never waits for a settle; auto continues as soon as no
live/outcome-pending id remains. The resume-settle unpause path applies ONLY
to ids that actually reached `resume-started`.

Unrelated `agent_settled` never removes a Wait ID. Auto sends no
`wait or continue` while live or outcome-pending is nonempty. When the last
remaining id is removed — matching outcome turn settled, or cancelled — auto
continues exactly one next preserved iteration. External/member messages can
still wake and run the Pi session while auto is paused.

Shutdown clears both Bebop waits and auto suspension without resuming work.
Bounded stale safety may warn, but must never send while any confirmed Wait ID
is live or outcome-pending.

### 9. Migration and errors

This intentionally changes provisional `timeout_seconds` semantics from a
pre-dispatch total timeout to post-idle grace. An old value maps directly to
`max_wait_seconds` only when it satisfies the new hard-safety range and remains
strictly greater than chosen grace. Other callers must choose a valid new pair;
there is no silent clamp or rewrite. Even a directly mapped value is not
temporally identical—the fixed acceptance phase can add up to 5 seconds before
hard safety begins—so this is a documented breaking provisional-contract
change. No compatibility alias or dual meaning remains.

Stable validation errors:

- invalid `timeout_seconds` → `invalid-timeout`;
- invalid/out-of-range `max_wait_seconds`, or a value not greater than grace → `invalid-max-wait`;
- wait capacity overflow → `capacity`.

UL, tool descriptions, workflow docs, schemas, and tests must present one
current contract only.

## Acceptance criteria

- [ ] Pure state-machine tests cover every transition and terminal union.
- [ ] Fake-clock tests prove 5s acceptance, 120s grace, 1800s hard default, independent configured timers, hard truncation, exact ties, and cleanup once.
- [ ] Pre-request idle never arms grace; first post-context idle arms once; later settles do nothing.
- [ ] Idle notification is internal/nonresuming and Request-scoped; it never appears as Member Idle Wait or public outcome.
- [ ] Reminder is delivered once with original Request ID; response before idle/during reminder/during grace wins; reminder failure does not alter Request outcome.
- [ ] Terminal-before-delivery drops an unaccepted reminder; an already FIFO-accepted reminder may enter context but terminal tombstone makes it stale and unable to change Request state.
- [ ] Response beats same-handler offline; offline beats timers; first terminal blocks all later callbacks.
- [ ] Requester and responder roles can coexist in one member; parked outbound wait never prevents processing inbound Request.
- [ ] Duplicate park is idempotent with no event/socket/timer; capacity 16 is enforced.
- [ ] Real event/barrier integration proves auto pauses through queued and unrelated turns, then continues only after matching started outcome turn settles.
- [ ] Multiple Wait IDs remain paused until all matching settled/cancelled events remove them.
- [ ] Cancelled waits require no outcome turn: auto continues as soon as no live/outcome-pending id remains (no settle needed for cancel).
- [ ] Mutual idle waits and nested Member requests leave sessions mechanically idle and resolve through Response/offline/grace/hard safeguards without blocking tool promises.
- [ ] Zero-listener, other-name, malformed-payload, unknown-ID, cancellation, shutdown, busy-buffering, and multi-resume-one-turn paths are deterministic; exact-name/live-ID publication is documented as unauthenticated process-local coordination.
- [ ] Member Idle Wait remains independently compatible, including CLI blocking semantics.
- [ ] No polling, wall-clock sleeps, heuristic message parsing, task inference, automatic completion, or Crew-role permission.
- [ ] UL/docs/tool help remove `idle-without-response` public outcome and explain migration/defaults without contradictory legacy text.
- [ ] TASK-0080 implementation uses deterministic fake clocks/barriers and both repositories' fresh final gates.

## Out of scope

- Streaming/multiple Responses, durable/cross-restart requests, CLI Member
  request workflow, changing CLI Member Idle Wait, task tracking, or stopping
  the user's auto loop.

## Verification

Product and independent QA approve this single contract before TASK-0080.
