---
id: TASK-0151
title: Make Request outcome waiting mechanically accurate
status: todo
depends_on: []
priority: high
tags: [member-request, requester, wait, termination, timeout, coordination, ux]
---

# Make Request outcome waiting mechanically accurate

## Problem

`wait_for_request_outcome` tells the Requester that its run yielded, but the
successful tool result does not set Pi's `terminate: true`. Pi can therefore
continue the same model run after the agent explicitly chose to wait. This
invites more tool calls, repeated waits, and confusing coordination while no
new Request outcome exists.

Bebop also publishes five `pi-bebop:wait-*` events described as an integration
with `/auto`, but the real `pi-auto` consumes none of them. Only a test stub
models that handshake. This creates a public-looking contract and maintenance
cost for behavior Bebop neither owns nor provides.

## Desired outcome

Sending and waiting remain separate:

```text
send_member_request()       # return after accepted delivery
continue ready work         # optional parallel coordination
wait_for_request_outcome()  # explicitly end this run and wait once
```

`wait_for_request_outcome` blocks the same tool call until the oldest terminal
Response, offline event, or bounded timeout. Timeout text gives the Requester
practical recovery choices without automatically redirecting, retrying,
persisting, or reassigning.

Bebop does not pause, resume, cancel, or otherwise absorb `/auto`. Automatic
iteration policy remains outside Bebop.

## Approved contract

### Successful wait

- `wait_for_request_outcome` remains Requester-side and argument-free.
- It blocks the current tool call until the oldest terminal outbound Request
  outcome, using the same execution shape as `wait_for_member_idle`.
- The same call resolves directly with Response, offline, or bounded timeout;
  it does not park a yielding registry wait or create a later resume turn.
- It must not claim to block sockets or other sessions; only its own tool call
  waits.

### Non-wait results

- With no pending or buffered outbound Request, return normal `all-settled`
  success with `pending_count: 0`; do not terminate or create wait state.
- Validation, capacity, and lifecycle failures remain actionable failures and
  do not claim that a wait was parked.
- A terminal outcome buffered before the call is delivered immediately and
  exactly once through existing Request-outcome ordering.

### Terminal resume

Only these terminal outcomes resume parked Requester:

- correlated `Response`, preserving full message and ordered instructions;
- `offline`;
- timeout with `response-after-idle` reason;
- timeout with `max-wait` reason.

Current `dev` behavior is already terminal-only. Do not introduce or port the
experimental TASK-0144 requester-side `still-pending` wake/re-wait loop.

### Actionable recovery

- `response-after-idle`: explain that Member settled without Response; if an
  answer is still required, send a new Member Request.
- `max-wait`: explain that no Response arrived before safety deadline; suggest
  checking Member Status, reassigning, durable Inbox delivery, or an explicit
  Redirect when urgent.
- `offline`: suggest reassigning or durable Inbox delivery.
- Wording never claims work failed, stopped, completed, or was verified.
- Bebop presents choices only; it does not choose or invoke recovery tools.

### Ownership boundary

- Remove yielding wait registry state, `crew-wait-resume` delivery, and the five
  `pi-bebop:wait-*` auto-shaped shared integration events from Request outcomes.
- Remove the in-repository `AutoLoopStub` handshake tests and maintained claims
  that Bebop pauses or resumes `/auto`.
- Preserve the single blocking waiter, terminal ordering, cancellation, bounded
  safeguards, privacy, and exactly-once direct result behavior.
- `/auto` scheduling remains out of scope and must not gain Bebop-specific
  control.

## Acceptance criteria

- [ ] TDD proves the wait blocks the same tool call until a terminal outcome;
      no immediate `terminate` result or later resume turn is created.
- [ ] No pending outbound Request returns immediate nonterminating all-settled;
      validation, lifecycle, and one-wait capacity failures are actionable.
- [ ] Response, offline, response-after-idle timeout, and max-wait timeout each
      resolve exactly once; malformed state cannot consume the waiter.
- [ ] FIFO ordering and full Response message plus ordered instructions are
      preserved in the direct result.
- [ ] Timeout and offline results contain approved actionable recovery without
      automatic side effects or inferred task state.
- [ ] Abort and bounded safeguards release the blocking call while preserving
      request state; only one local waiter is active.
- [ ] Existing send/response behavior, timers, first-terminal arbitration,
      privacy, and nonblocking delegation remain unchanged.
- [ ] Remove yielding registry, `crew-wait-resume` Request delivery, old wait
      event constants/publication, AutoLoopStub tests, and stale `/auto` claims.
- [ ] Focused unit/integration coverage, architecture/package checks, full gate,
      fresh watcher fingerprint, and independent exact-head QA pass.

## Constraints

- Preserve nonblocking `send_member_request`, parallel delegation,
  Requester/Responder roles, opaque Request IDs, finite grace/max-wait timers,
  transient channels, capacity bounds, privacy, and first-terminal arbitration.
- Use Pi's public terminating tool-result contract. Do not hold an unresolved
  tool promise, block socket processing, poll, sleep, or parse prompts.
- Keep Bebop transport-focused. Coordinator workflow and `/auto` policy remain
  outside this extension.

## Non-goals

- Making `send_member_request` wait for Response.
- Controlling or modifying `/auto`.
- Adding progress events, recurring reminders, automatic nudges, task inference,
  automatic reassignment, or durable Requests.
- Changing target-side first-idle Response reminder, timeout defaults,
  `wait_for_member_idle`, or ordinary Follow-up behavior.
- Proving that a Response is correct, complete, or verified.

## Verification

- Previous terminate-based implementation and independent QA at
  `64fe44c2f7102d88adf1e6d360752666c7cd2a89` are superseded by this refined
  blocking-wait contract.
- Fresh focused coverage and exact-head QA are required after implementation.

## Evidence

- The previous implementation returned `terminate: true` and later
  `crew-wait-resume`; product review rejected that execution shape in favor of
  a blocking call like `wait_for_member_idle`.
- Real `pi-auto` had no consumer for Bebop's old five wait events; `/auto` stays
  outside this task.
