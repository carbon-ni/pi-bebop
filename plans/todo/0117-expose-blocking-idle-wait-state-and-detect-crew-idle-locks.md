---
id: TASK-0117
title: Expose blocking idle-wait state and detect Crew Idle Locks
status: todo
depends_on: [TASK-0089, TASK-0116, TASK-0120]
priority: high
tags: [crew, idle, wait-lock, lifecycle, protocol, privacy, tdd]
---

# Expose blocking idle-wait state and detect Crew Idle Locks

## Problem

A remote Member blocked inside `wait_for_member_idle` or a Crew Idle Gate looks only `busy` today. Generic activity cannot distinguish useful work from a coordination lock, so a Lead waiting for the Crew could remain blocked until timeout even when every Member is waiting for someone else to become idle.

## Outcome

Add a minimal, transient, mechanically derived blocking-wait signal and a pure Crew Idle Lock detector. This is the guardrail seam required by TASK-0118; it must remain independent from Lead role, task state, and recovery policy.

## Implementation plan

1. Write failing lifecycle/reducer tests for entering, observing, transitioning, and leaving `member-idle` and `crew-idle` wait states.
2. Add one runtime-owned active blocking-wait slot. Registration occurs before remote subscriptions; cleanup occurs exactly once on every success, message wake, lock, offline, timeout, unstable, abort, error, reload, and shutdown path.
3. Expose a finite-time snapshot plus one-shot transition notification through injected application/transport adapters. Do not overload ordinary `busy` inference or inspect tool arguments.
4. Add a pure manifest-order detector that returns Crew Idle Lock only when caller owns agent `crew-idle`, the normalized selection covers every other frozen manifest Member, and every online target explicitly reports an active blocking idle wait.
5. Keep wire schemas strict, bounded, identity-checked, membership-scoped, and privacy-safe.
6. Reuse the single local blocking-wait/wake ownership gate so concurrent local Member/Crew waits reject before remote IO rather than replacing each other.

## Acceptance criteria

- [ ] Tests first prove the active marker is `none | member-idle | crew-idle`, runtime-derived, transient, and never author supplied.
- [ ] Marker is acquired before target IO and released exactly once on every terminal, cancellation, thrown error, reload, shutdown, and partial-setup failure.
- [ ] A second local blocking idle wait rejects deterministically before remote IO and cannot share, replace, or clear the first marker.
- [ ] Joined trusted peers can obtain a bounded current snapshot and one-shot transition notification; unjoined, untrusted, foreign-identity, malformed, timeout, capacity, and disconnected paths reject deterministically.
- [ ] Notification is event-driven and race-safe: subscribe plus current-state snapshot cannot lose a transition into or out of blocking wait.
- [ ] Lock detector uses the fixed manifest target set, full-roster coverage, and explicit marker only; generic busy/compacting, offline, missing, stale, failed, or proper-subset observations never become false Crew Idle Lock evidence.
- [ ] Full selection with every online target in a blocking idle wait produces `wait-lock`; any proper subset, idle, working-busy, compacting, offline, unknown, or changing target prevents that whole-Crew conclusion.
- [ ] Same-boundary message wake and marker transition preserve TASK-0089 immediate-message consumption and deterministic cleanup.
- [ ] Public data contains only configured name/role, wait kind, and observation time—never wait target, tool arguments, messages, prompts, instructions, session IDs, paths, model data, or inferred task/intent.
- [ ] State is non-durable and restart-safe: restart begins with `none`; no historical wait timeline or background monitor is created.
- [ ] Existing Member Idle Wait semantics remain unchanged except explicit marker lifecycle; mutual single-Member waits still rely on message/offline/abort/timeout unless a Crew Idle Gate observes and releases itself.
- [ ] Focused domain, application, protocol, real-socket, lifecycle, architecture, and regression gates pass.

## Out of scope

- Automatically cancelling another Member's wait.
- General wait-for graph/cycle diagnosis, task ownership, availability, or productivity tracking.
- Persisting wait state or exposing wait targets/content.
- Implementing the Crew-wide tool itself; TASK-0118 owns orchestration.
