---
id: TASK-0116
title: Define Crew-wide idle gate semantics
status: doing
depends_on: [TASK-0046, TASK-0050, TASK-0081]
priority: high
tags: [crew, idle, coordination, auto, wait-lock, product, ubiquitous-language, determinism]
---

# Define Crew-wide idle gate semantics

## Problem

A Lead coordinating several Members can wait for only one Member today, forcing token-consuming status loops or premature routing. Bebop needs an honest bounded contract for waiting until a final Crew status round observes every other configured Member idle, including a guardrail for the case where blocking idle waits prevent anyone from settling.

## Desired outcome

Define **Crew Idle Gate** as a one-shot, event-driven coordination primitive exposed later as:

```text
wait_for_crew_idle({ timeout_seconds?: 1800 })
```

The caller's current run remains blocked without repeated model calls. The caller is excluded because its pending tool call makes it mechanically busy. The target set is an immutable manifest-order snapshot of every other configured Member at gate start.

A successful gate performs one concurrent **final status round** and returns `ready` only when every target in that round reports `online/idle`. This is stronger than remembering that each Member became idle once. It is not an atomic distributed snapshot: observations have individual timestamps, and no result promises that a Member remains idle after observation.

## Event-driven rounds

1. Snapshot current membership and one absolute deadline.
2. Query every target concurrently with finite transport bounds.
3. If every result is `online/idle`, return `ready`.
4. If any target is busy or compacting, atomically subscribe to those targets' idle/wait-state transitions; an already-idle subscription cannot lose the transition.
5. After the non-idle targets settle, run a new full-Crew status round. If an earlier Member became busy again, wait for it in the next round.
6. Stop on `ready`, accepted inbound Bebop message, Crew Idle Lock, offline target, bounded deadline, cancellation, named round limit, or protocol failure.

No polling interval, sleep, repeated model call, background watch, or automatic Member action is allowed.

## Crew Idle Lock guardrail

Define **Crew Idle Lock** as the mechanically observed state where:

- the caller owns an active Crew Idle Gate; and
- every other online configured Member currently owns a blocking Member Idle Wait or Crew Idle Gate.

Those pending tools keep every participating Pi run busy, so waiting for ordinary idle cannot make progress without an inbound message, offline transition, abort, or timeout. Bebop must expose minimal transient blocking-wait state so the condition is observed rather than inferred from generic `busy` activity.

When the condition is reached, the caller's gate cancels its remote subscriptions and returns `wait-lock`. This releases the Lead's run so it can choose a recovery action. Role is convention, not authority: any joined Member using the gate receives the same result. Bebop never automatically redirects, interrupts, aborts, assigns work, marks Members idle, or selects a recovery policy.

The marker is current mechanical state only. It contains a bounded wait kind (`member-idle` or `crew-idle`) and observation time; it exposes no messages, prompts, instructions, tool arguments, target names, session identifiers, paths, model data, or inferred intent.

## Terminal outcomes

- `ready` — final status round observed every selected target `online/idle`; disposition is `no-other-members`, `initial-round`, or `after-wait`.
- `wait-lock` — every selected online target is in a blocking idle wait while caller's Crew Idle Gate is active.
- `offline` — at least one selected target is unreachable before or during gate; offline is not idle.
- `timeout` — one absolute bounded deadline expires before readiness.
- `unstable` — named finite round limit is exhausted by repeated activity changes before deadline.
- `message-received` — accepted inbound Bebop message releases the gate and must be consumed next under its original delivery mode.
- caller abort and malformed/remote/capacity/transport failures remain explicit errors.

At the same scheduling boundary, accepted message wins so queued context is never skipped; otherwise the first committed terminal wins and all later callbacks only clean up.

## Acceptance criteria

- [ ] `UL.md` defines Crew Idle Gate, final status round, and Crew Idle Lock separately from Member Idle Wait, Member Status, task completion, response correlation, Presence, and availability.
- [ ] Target set is a manifest-order snapshot of every other configured Member; self is excluded and a one-Member Crew returns `ready/no-other-members` without transport IO.
- [ ] `ready` requires every target response in one final round to be `online/idle`; prior idle observations alone never satisfy the gate.
- [ ] Contract explicitly states the final round is not an atomic simultaneous snapshot and makes no promise of future idleness, task completion, acknowledgement, willingness, or lack of queued work.
- [ ] Busy and compacting are non-ready; offline is an explicit non-ready terminal rather than silently excluded or treated as idle.
- [ ] Repeated rounds are event-driven and bounded by one absolute deadline plus a named finite round limit; no polling or per-target timeout multiplication.
- [ ] Crew Idle Lock is detected from explicit transient blocking-wait state, never generic `busy` status or conversation/task inference.
- [ ] Lock detection releases only caller's gate with `wait-lock`; it never changes another Member's run or grants Lead role authority.
- [ ] Accepted inbound message, ready, wait-lock, offline, timeout, unstable, abort, and failure races have deterministic first-terminal cleanup and documented priority.
- [ ] Results are bounded, manifest-ordered, privacy-safe, and contain only configured identity plus mechanical outcome/observation data.
- [ ] A deterministic adversarial matrix covers initial ready, busy-to-ready, earlier Member becoming busy again, compaction, offline/restart, activity churn, message wake, timeout, cancellation, no peers, mutual waits, all-Member Crew Idle Gates, and same-boundary races.

## Constraints and non-goals

- Agent-facing extension tool first; CLI and slash-command parity are separate future decisions.
- No automatic routing, scheduling, task assignment, retry policy, escalation, interruption, or deadlock recovery action.
- No durable wait-state history, monitoring dashboard, arbitrary wait graph, productivity inference, conversation inspection, polling, or claim of a mathematically atomic distributed snapshot.
