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

A successfully parked outcome wait mechanically terminates the current Pi run.
Bebop later starts a new outcome turn for the oldest terminal Response, offline
event, or bounded timeout. Timeout text gives the Requester practical recovery
choices without automatically redirecting, retrying, persisting, or reassigning.

Bebop does not pause, resume, cancel, or otherwise absorb `/auto`. Any automatic
iteration scheduled after a terminated Pi run belongs to `/auto` or Pi core.

## Approved contract

### Successful wait

- `wait_for_request_outcome` remains Requester-side and argument-free.
- It parks one idempotent wait for the oldest terminal outbound Request outcome.
- A successful park returns Pi's standard `terminate: true` result.
- The tool must be called alone. Under Pi batch semantics, termination applies
  only when every finalized sibling tool result also terminates.
- Its result says the current run ended and a later terminal outcome will start
  a new turn; it must not claim to block Pi runtime, sockets, or other sessions.

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

- Remove `pi-bebop:wait-parked`, `wait-resume-queued`,
  `wait-resume-started`, `wait-resume-settled`, and `wait-cancelled` as
  auto-shaped shared integration events when no Bebop behavior requires them.
- Remove the in-repository `AutoLoopStub` handshake tests and maintained claims
  that Bebop pauses or resumes `/auto`.
- Preserve internal wait lifecycle state needed for terminal delivery,
  cancellation, shutdown, privacy, and exactly-once behavior.
- `/auto` scheduling after a terminated run is out of scope. Any future solution
  must use a generic Pi or `/auto` contract rather than Bebop-specific control.

## Acceptance criteria

- [x] Tests first prove current successful wait returns no `terminate` flag and
      permits Pi's automatic post-tool model continuation.
- [x] A successful sole `wait_for_request_outcome` result returns
      `terminate: true` and Pi performs no further model step in that run.
- [x] Parallel-batch coverage documents Pi's all-results-must-terminate rule;
      tool description and guidance say to call this wait alone.
- [x] `all-settled`, validation failure, capacity failure, and rejected park do
      not return a false terminating/yielded success.
- [x] Semantic duplicate park remains one-shot/idempotent with no duplicate
      listener, timer, outcome, or resume turn.
- [x] Response, offline, response-after-idle timeout, and max-wait timeout each
      resume exactly once; malformed terminal payload cannot consume parked wait.
- [x] Buffered terminal outcome preserves oldest-first FIFO and is consumed
      exactly once.
- [x] Response resume preserves complete message and ordered instructions.
- [x] Timeout and offline results contain approved actionable recovery without
      automatic side effects or inferred task state.
- [x] Busy-run terminal delivery remains queued as Follow-up and idle-run
      delivery remains Steering; neither duplicates or loses outcome.
- [x] Cancellation, abort, clear, Membership loss, and shutdown release exact
      parked wait and prevent stale later resume.
- [x] Remove unused auto-shaped shared event publication, event constants,
      extension hooks, `AutoLoopStub` tests, and maintained auto-integration
      claims without disturbing internal wait lifecycle.
- [x] Repository search outside historical plans/reports contains no claim that
      Bebop controls, pauses, or resumes `/auto`.
- [x] Current terminal-only behavior remains authoritative; no requester-side
      `still-pending` reminder or nonterminal wake is added.
- [x] Focused unit/integration coverage, architecture/package checks, full gate,
      fresh unchanged watcher fingerprint, and independent exact-head QA pass.

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

- Independent exact-head QA: watcher generation 43 passed `@agent-final` at
  commit `64fe44c2f7102d88adf1e6d360752666c7cd2a89`, with a clean unchanged
  worktree fingerprint.
- Focused wait/request tests, formatting, typecheck, architecture/package checks,
  and the full gate passed before closure.

## Evidence

- The pre-fix tool result had `terminate: undefined`; Pi terminates post-tool
  continuation only when every finalized batch result has `terminate: true`.
- Current `dev` is terminal-only; experimental TASK-0144 contains the separate
  `still-pending` behavior and is not the contract for this task.
- Real `pi-auto` had no consumer for Bebop's five wait events; the removed
  in-repository handshake was only a test stub.
