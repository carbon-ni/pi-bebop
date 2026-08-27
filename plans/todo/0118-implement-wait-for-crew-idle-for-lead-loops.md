---
id: TASK-0118
title: Implement wait_for_crew_idle for Lead loops
status: todo
depends_on: [TASK-0117]
priority: high
tags: [crew, idle, tools, auto, coordination, wait-lock, determinism, tdd]
---

# Implement `wait_for_crew_idle` for Lead loops

## Problem

The agreed Crew Idle Gate and lock signal have no agent-facing extension operation. Lead loops need one event-driven blocking tool that waits, performs a final full-Crew status round, releases on Crew Idle Lock, and resumes without token-consuming model polling.

## Public surface

```text
wait_for_crew_idle({ timeout_seconds?: 1800 })
```

The tool has no Member selector: it snapshots every other configured Member. It blocks the caller's current run, so pi-auto's existing pending-send gate prevents another Lead iteration until this tool returns or terminates for an inbound message.

## Implementation plan

1. Add failing domain fixtures for strict result schema, manifest ordering, terminal priority, absolute deadline, round bound, and privacy exclusions.
2. Add an application orchestrator with injected membership, clock/deadline, concurrent Member Status, blocking-wait observation, and Member Idle Wait adapters.
3. Query each round concurrently, normalize responses to manifest order, wait concurrently only for non-idle Members, and re-query the full target set before `ready`.
4. Register one local wake/ownership gate for the whole operation. Accepted inbound message cancels every outstanding probe/subscription and returns `message-received` with `terminate: true` under TASK-0089 rules.
5. Detect explicit Crew Idle Lock during initial status, subscription snapshots, and later wait-state transitions; cancel remaining work and return ordinary `wait-lock` so caller can act.
6. Enforce one absolute timeout and finite round cap across all targets/rounds. Abort and every early terminal cancel all in-flight work exactly once.
7. Register concise membership-scoped tool guidance that teaches wait-then-act without claiming completion or granting Lead role authority.

## Acceptance criteria

- [ ] TDD starts with happy and unhappy paths before orchestration code.
- [ ] Tool schema exposes only optional bounded integer `timeout_seconds`; default/range match current Member Idle Wait unless TASK-0116 contract records a deliberate change.
- [ ] Unjoined or untrusted caller rejects before target IO; target snapshot excludes self, preserves manifest order, and remains fixed for the operation.
- [ ] One-Member Crew returns `ready/no-other-members` immediately without probes or subscriptions.
- [ ] Initial all-idle round returns `ready/initial-round`; busy/compacting targets are awaited concurrently, then a full final round is required for `ready/after-wait`.
- [ ] If an earlier-idle Member is busy in the final round, tool starts another event-driven round and never returns from remembered idle observations.
- [ ] Explicit all-target blocking-wait observation returns `wait-lock`, cancels all remote work, and gives caller a normal continuation; no Member is remotely changed.
- [ ] Offline target returns bounded `offline`; it is never excluded, treated as idle, or automatically reconnected.
- [ ] One absolute timeout and named round cap produce deterministic `timeout`/`unstable` results with compact last-known blockers; per-target work cannot multiply deadline.
- [ ] Accepted inbound Follow-up/Redirect/Request/Response/Inbox/Broadcast message wins the same-boundary race, cancels the gate, returns terminating `message-received`, and is the exact next model context under original delivery mode.
- [ ] Abort, malformed response, capacity, transport failure, membership loss, target restart, and partial setup each clean every timer, listener, socket request, marker, and remote subscription exactly once.
- [ ] Concurrent local `wait_for_member_idle`/`wait_for_crew_idle` calls reject `wait-in-progress` before remote IO.
- [ ] Deterministic barriers prove concurrent fan-out with manifest-ordered output independent of response order; no serial timeout multiplication, polling, sleeps, or unbounded promise remains.
- [ ] Result/text are bounded and expose only configured identities plus mechanical status/outcome timestamps; no paths, messages, wait targets, prompts, tools, instructions, model data, or intent.
- [ ] Tool help states final round is non-atomic and momentary; `ready` never proves task completion, response, acknowledgement, availability, willingness, or future idle state.
- [ ] Existing Member Status, Member Idle Wait, request-outcome wait, message wake, pi-auto, protocol, and membership tests remain green.

## Out of scope

- CLI/slash-command parity, automatic routing, automatic recovery, remote abort/redirect/interrupt, persistent monitoring, task inference, or arbitrary Member subsets.
