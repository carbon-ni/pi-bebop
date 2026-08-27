---
id: TASK-0119
title: Verify and document Crew Idle Gate orchestration
status: todo
depends_on: [TASK-0118]
priority: high
tags: [crew, idle, auto, wait-lock, verification, documentation, recovery]
---

# Verify and document Crew Idle Gate orchestration

## Problem

A multi-Member gate can appear correct while racing activity changes, missing Crew Idle Locks, leaking subscriptions, or allowing the Lead loop to continue early. The complete wait-then-act lifecycle needs independent adversarial verification and concise operator guidance.

## Verification plan

1. Build a requirement-to-fixture acceptance matrix before accepting implementation.
2. Exercise pure state races with deterministic barriers/fake clocks and real multi-socket integration with at least Lead, developer, and quality Members.
3. Characterize Pi host and pi-auto behavior at the provider-context boundary, not only mocked adapter calls.
4. Verify restart/shutdown/cancellation and protocol compatibility from clean package installation.
5. Update UL, tool guidance, README/workflow documentation, and one copyable Lead-loop example.

## Acceptance criteria

- [ ] Independent matrix maps every TASK-0116/0117/0118 criterion to executable evidence; prose or keyword presence alone cannot pass.
- [ ] Black-box scenario proves Lead remains in one pending run while any target is working and pi-auto sends no second iteration.
- [ ] Busy Members settling in different orders trigger a full final status round; a Member becoming busy again prevents readiness until a later all-idle round.
- [ ] Initial all-idle and no-other-Member paths return immediately with no lingering subscriptions.
- [ ] Developer↔quality mutual Member Idle Wait while Lead waits for Crew yields `wait-lock` to Lead before normal timeout; both remote waits remain untouched.
- [ ] All Members entering Crew Idle Gates produces deterministic caller-local lock release without remote cancellation, authority inference, or false idle result.
- [ ] A working-busy or compacting Member prevents false wait-lock; ordinary busy is never interpreted as blocking wait.
- [ ] Same-boundary message versus ready/lock/offline/timeout proves accepted message is consumed exactly once as next provider context and retains payload, instructions, Origin, mode, and FIFO order.
- [ ] Offline before/during wait, restart, timeout, round exhaustion, malformed response, capacity, abort, membership loss, reload, and shutdown are bounded and leak-free.
- [ ] Randomized response completion order produces byte-stable manifest-ordered structured results for identical semantic inputs.
- [ ] Privacy tests reject messages, wait targets, prompts, instructions, session IDs, aliases, paths, model data, and inferred task/progress from output and state signals.
- [ ] Documentation gives a Lead loop example: route work, call `wait_for_crew_idle`, act only on `ready`, resolve `wait-lock`, inspect `offline/timeout/unstable`, and process waking messages first.
- [ ] Documentation explicitly says final status round is distributed and momentary, not atomic simultaneity, completion, acknowledgement, availability, willingness, or promise to remain idle.
- [ ] Mutual blocking limits for single-Member waits remain documented; Crew Idle Gate detects only its defined whole-Crew lock, not arbitrary hidden dependency cycles.
- [ ] Focused tests, typecheck, formatting, architecture/package checks, coverage/risk gate, clean full hooks, and fresh watcher verification pass with unchanged-worktree proof.

## Non-goals

- Automatically choosing how Lead breaks a lock.
- Automatically interrupting, redirecting, aborting, messaging, or assigning another Member.
- CLI parity, dashboards, durable monitoring, task completion tracking, productivity scoring, or conversation inspection.
