---
id: TASK-0118
title: Implement wait_for_crew_idle for Lead loops
status: todo
depends_on: [TASK-0117, TASK-0120]
priority: high
tags: [crew, idle, tools, auto, coordination, wait-lock, determinism, tdd]
---

# Implement `wait_for_crew_idle` for Lead loops

## Problem

The agreed Crew Idle Gate and lock signal have no agent-facing extension operation. Lead loops need one event-driven blocking tool that waits, performs a final full-Crew status round, releases on Crew Idle Lock, and resumes without token-consuming model polling.

## Public surface

```text
wait_for_crew_idle({ members?: ["Dave", "Kelly"], timeout_seconds?: 1800 })
```

Omitted `members` snapshots every other configured Member. A non-empty array selects exact configured names and normalizes them into manifest order under TASK-0120. The tool blocks the caller's current run, so pi-auto's existing pending-send gate prevents another Lead iteration until this tool returns or terminates for an inbound message.

## Implementation plan

1. Add failing domain fixtures for strict selection/result schemas, manifest ordering, terminal priority, absolute deadline, round bound, and privacy exclusions.
2. Add an application orchestrator with injected membership, target selection, clock/deadline, concurrent Member Status, blocking-wait observation, and Member Idle Wait adapters. Keep it free of Pi tool/command types so TASK-0121 can reuse it.
3. Query each round concurrently, normalize responses to frozen manifest order, wait concurrently only for selected non-idle Members, and re-query the full selected target set before `ready`.
4. Register one local wake/ownership gate for the whole operation. Accepted inbound message cancels every outstanding probe/subscription and returns `message-received` with `terminate: true` under TASK-0089 rules.
5. Detect explicit Crew Idle Lock during initial status, subscription snapshots, and later wait-state transitions; cancel remaining work and return ordinary `wait-lock` so caller can act.
6. Enforce one absolute timeout and finite round cap across all targets/rounds. Abort and every early terminal cancel all in-flight work exactly once.
7. Register concise membership-scoped tool guidance that teaches wait-then-act without claiming completion or granting Lead role authority.

## Acceptance criteria

- [ ] TDD starts with happy and unhappy paths before orchestration code.
- [ ] Tool schema exposes only optional non-empty bounded exact-name `members` array and optional bounded integer `timeout_seconds`; timeout default/range match TASK-0116/TASK-0120.
- [ ] Unjoined/untrusted, empty, duplicate, self, unknown, Role-based, malformed, and oversized selection rejects before target IO; valid targets preserve manifest order and remain fixed for the operation.
- [ ] Omitted selection snapshots every other configured Member; one-Member Crew returns `ready/no-other-members` immediately without probes/subscriptions. Explicit selection returns `scope=selected` and never claims whole-Crew ready.
- [ ] Initial all-idle round returns `ready/initial-round`; busy/compacting targets are awaited concurrently, then a full final round is required for `ready/after-wait`.
- [ ] If an earlier-idle Member is busy in the final round, tool starts another event-driven round and never returns from remembered idle observations.
- [ ] Explicit blocking-wait observation returns `wait-lock` only when normalized selection covers every other frozen Member; a proper subset never makes a whole-Crew lock claim. Caller cleanup gives normal continuation and no Member is remotely changed.
- [ ] Offline target returns bounded `offline`; it is never excluded, treated as idle, or automatically reconnected.
- [ ] One absolute timeout and named round cap produce deterministic `timeout`/`unstable` results with compact last-known blockers; per-target work cannot multiply deadline.
- [ ] Accepted inbound Follow-up/Redirect/Request/Response/Inbox/Broadcast message wins the same-boundary race, cancels the gate, returns terminating `message-received`, and is the exact next model context under original delivery mode.
- [ ] Abort, malformed response, capacity, transport failure, membership loss, target restart, and partial setup each clean every timer, listener, socket request, marker, and remote subscription exactly once.
- [ ] Concurrent local `wait_for_member_idle`/`wait_for_crew_idle` calls reject `wait-in-progress` before remote IO.
- [ ] Deterministic barriers prove concurrent fan-out with manifest-ordered output independent of response order; no serial timeout multiplication, polling, sleeps, or unbounded promise remains.
- [ ] Result/text are bounded and expose scope, frozen configured identities, and mechanical status/outcome timestamps; selected readiness is labeled honestly. No paths, messages, wait targets, prompts, tools, instructions, model data, or intent.
- [ ] Tool help states final round is non-atomic and momentary; `ready` never proves task completion, response, acknowledgement, availability, willingness, or future idle state.
- [ ] Existing Member Status, Member Idle Wait, request-outcome wait, message wake, pi-auto, protocol, and membership tests remain green.

## Out of scope

- Slash-command adapter (TASK-0121), standalone CLI parity, automatic routing, automatic recovery, remote abort/redirect/interrupt, persistent monitoring, task inference, Role/pattern selection, or comma-separated parsing.
