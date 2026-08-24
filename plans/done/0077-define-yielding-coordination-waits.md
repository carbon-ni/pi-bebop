---
id: TASK-0077
title: Define yielding coordination waits
status: done
depends_on: []
priority: high
tags: [wait, lifecycle, yield, resume, deadlock, tdd]
---

# Define yielding coordination waits

## Problem

Agent-facing wait tools (`wait_for_member_idle`, `wait_for_request_outcome`)
keep the current Pi run mechanically busy while waiting on another member: the
tool's `execute` promise stays pending, so the run never settles. Two members
waiting on each other (mutual idle waits or mutual Request-outcome waits) hold
both runs busy until the finite deadline — a mutual busy-wait deadlock.

Waiting must **yield the current run** and resume only through **one-shot
lifecycle delivery** instead of holding tool execution open.

## Evidence (from existing protocol/runtime)

- `registerWaitForMemberIdleTool`/`registerWaitForRequestOutcomeTool` await a
  pending transport promise; the run stays busy until terminal or abort.
- Pi exposes no first-class yield API in `ExtensionContext`. Available
  lifecycle: `agent_end` (after a run), `agent_settled` ("after an agent run
  has fully settled and no automatic retry, compaction, or queued continuation
  will run"), `turn_start`/`turn_end`; `pi.sendMessage(..., { triggerTurn:
  true, deliverAs: "steer"|"followUp"|"nextTurn" })` starts a new turn.
- One-shot terminal delivery already exists on the wire: idle subscriptions
  (`state.idleWaitSubscriptions`) and Request outcome updates
  (`RequestOutcomeRegistry` waiter/buffered) — the extension already receives
  the terminal event from the target over RPC without polling.
- `ExtensionContext.hasPendingMessages()` exposes Pi's queued-message signal.

## Proposed design

Yield-and-resume, no polling, no grace:

1. A wait tool call registers a **pending wait** in a new extension-side
   one-shot registry (kind: `member-idle` | `request-outcome`; target; bound
   deadline) and **returns immediately** with a deterministic "yielded, waiting"
   result. The agent run then ends normally (`agent_settled` fires).
2. When the terminal lifecycle delivery arrives (target RPC update: member
   idle / Request outcome / offline / timeout), the extension emits exactly
   **one resume message** into the waiting session
   (`pi.sendMessage`, dedicated customType, `triggerTurn: true`) carrying the
   bounded outcome (wait kind + member/requestId + outcome). No polling, no
   grace, no duplicate.
3. If the outcome arrives while the session run is active, the resume message
   is queued one-shot (Pi's followUp queue) so it is delivered at the next
   natural turn start — never lost, never doubled.
4. The pre-dispatch deadline remains the fallback; yielding never extends or
   moves it. Abort cancels the pending wait and never emits a resume.

## Refined acceptance criteria (derived from evidence)

- [ ] Failing two-runtime reproduction pre-fix: source and target each wait on
      the other (idle or Request outcome); both runs stay busy until the
      deadline (mutual busy-wait deadlock).
- [ ] A wait tool call returns a deterministic "yielded, waiting" result
      immediately and the current run settles (`agent_settled`) before any
      terminal outcome; it never holds tool execution open.
- [ ] Exactly one resume message is delivered to the waiting session on the
      first terminal lifecycle delivery (idle / request outcome / offline /
      timeout), carrying the bounded outcome; no duplicates, no lost outcomes,
      no polling/grace/sleep.
- [ ] Mutual waits no longer deadlock: with yielding, each member's run
      settles and each wait resumes on the other's lifecycle delivery (idle
      waits resolve when the other settles; Request waits resolve via
      response/idle-without-response/offline as defined by TASK-0075).
- [ ] Outcome arriving while the run is active is buffered one-shot and
      delivered at the next turn start; same-boundary ordering stays
      deterministic (first terminal wins; TASK-0075 registry semantics kept).
- [ ] Abort/cancel removes the pending wait and never emits a resume; SIGINT
      stays bounded.
- [ ] Pre-dispatch Request deadline unchanged (register-before-dispatch,
      fallback only); Member Idle Wait timeout remains an expected outcome.
- [ ] Wait tool descriptions/affordances updated to "yields this run and
      resumes on one-shot lifecycle delivery" (consistent with TASK-0076
      requester/responder wording); the resume message is structurally marked
      in model context and UI (bounded, no socket/session/manifest paths).
- [ ] Focused runtime/lifecycle/application/packaged tests with barriers and
      fake clock (no wall-clock sleeps); touched coverage and fresh final
      watcher gate green.

## Risks / open decisions (report before coding)

1. **No first-class yield API** — yielding is end-run + resume-message. The
   agent must understand "tool returned yielded; outcome arrives in a later
   turn" — tool wording and resume message format are a product decision.
2. **Resume message design** — new customType + bounded payload (kind, member/
   requestId, outcome, deadline?); must render distinctly (TASK-0076 style)
   and never expose callback routes.
3. **Both waits or one first** — shared extension-side pending-wait registry +
   event wiring suggests implementing both together as one coherent lifecycle
   change (idle + request outcome), with the idle wait as the walking skeleton.
4. **Busy-run buffering** — depends on Pi followUp queue semantics; must be
   verified, not assumed (deterministic test over the real runtime).
5. **Scope size** — touches both wait tools, extension event wiring, wait
   registries, renderer, tool descriptions, packaged tests. Medium-large; no
   protocol/terminal-outcome changes (TASK-0075/0076 semantics preserved).

## Out of scope

- Changing terminal outcomes/deadlines, adding polling/grace/sleep, new
  request kinds, CLI wait parity, or authentication.

## Implementation boundary (agreed with lead, 13-05)

IN:
- Pure domain `YieldingWaitRegistry` (`src/domain/yielding-wait.ts`): one-shot
  pending waits (kind `member-idle` | `request-outcome`; target member or
  requestId; deadlineAt; sessionId); register / resolve-once / cancel / capacity.
- `wait_for_member_idle` and `wait_for_request_outcome` yield: register a
  pending wait and return a deterministic "yielded, waiting" result
  immediately; the existing one-shot RPC subscription still arms, but the tool
  never awaits the terminal outcome.
- Resume delivery (`src/pi/wait-resume.ts`): on the first terminal lifecycle
  delivery (idle subscription event / Request outcome update / offline /
  timeout) resolve the parked wait exactly once and emit exactly ONE resume
  message via `pi.sendMessage` (customType `crew-wait-resume`, triggerTurn,
  bounded payload: kind + member/requestId + outcome + observedAt). If the run
  is active at that moment, queue one-shot (followUp) for the next turn start.
- Abort/cancel removes the parked wait, closes the subscription, never resumes.
- Deadlines unchanged (idle timeout bounded timer; Request deadline
  register-before-dispatch); timeout remains a fallback outcome via resume.
- Wait tool descriptions updated to yield semantics; resume message gets a
  TASK-0076-style bounded model+UI marker (no socket/session/manifest paths).

OUT (fence):
- RPC protocol, `RequestOutcomeRegistry` semantics, terminal outcome kinds,
  deadline start times, TASK-0075/0076 behavior, follow-up/redirect/inbox/
  broadcast/intake flows, any polling/grace/sleep, CLI wait parity, new request
  kinds, authentication.


## Done (13-05)

Implemented and verified (Tony confirmed all three open decisions):

- `src/domain/yielding-wait.ts` — pure one-shot `YieldingWaitRegistry`
  (kind `member-idle` | `request-outcome`; register / resolve-once / cancel /
  bounded capacity 16; member-idle target-scoped, request-outcome FIFO).
- `src/pi/wait-resume.ts` — `YieldingWaitRuntime`: park + resolve exactly once
  + one resume message (`crew-wait-resume`, bounded payload kind/target/
  outcome/observedAt; steer when run idle, followUp when busy).
- `wait_for_member_idle` + `wait_for_request_outcome` yield: deterministic
  `yielded` result immediately; never await the terminal outcome; abort
  cancels the parked wait (handles already-aborted signals) and never resumes.
- `prepareMemberIdleWait` on the idle-wait flow: validate + probe without
  blocking (offline stays immediate).
- Request-outcome pump (tool-owned, shared, survives the run): forwards each
  terminal/buffered outcome once; `hasPendingRequestOutcome` gates the
  no-pending error.
- UI: `wait-resume` session-message kind/label/hint; renderer reuses
  `renderSessionMessage`; packaged `files` entries added.
- TDD evidence: 11 new/updated unit tests + `yielding-wait.integration.test.ts`
  (real two-runtime mutual idle waits yield + resume exactly once; real
  request-outcome yield + idle-without-response resume).
- Gates: 887/887 tests; tsc clean; prettier clean; watcher `@agent-final`
  PASS gen=1327 (make all); CLI coverage gate 96.79% lines / 90.88% branches.


## QA fix (13-05, Kelly fail -> reopened -> fixed)

QA found: a matching terminal with a malformed outcome (`MALFORMED_UNEXPECTED`)
and `observedAt: NaN` consumed a parked wait and emitted a resume. Fixed with
TDD:

- `validateYieldingWaitTerminal` (`src/domain/yielding-wait.ts`): terminal
  payload gate — kind `member-idle`|`request-outcome`, target non-empty string,
  outcome a well-formed terminal outcome for the kind (member-idle:
  became-idle/already-idle/offline/timeout; request-outcome:
  response/idle-without-response/offline/timeout), observedAt finite number.
- `YieldingWaitRuntime.resolve` validates BEFORE registry consume: malformed/
  unexpected deliveries return false, leave the wait parked, never resume.
  A valid terminal still resolves exactly once afterwards.
- Regression tests: domain validator cases + runtime never-consume/never-resume
  + still-resolves-later; idle-wait tool test corrected to assert malformed
  transport code never resumes.
- Gates re-run: 889/889 tests; tsc + prettier clean; watcher @agent-final PASS
  gen=1339 (make all); CLI coverage gate 96.77% lines / 90.71% branches.
