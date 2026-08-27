---
id: TASK-0108
title: Remind facilitator when Crew Retrospective is due
status: doing
depends_on: [TASK-0107]
priority: high
tags: [crew-agreements, retrospective, cadence, lifecycle, determinism, tdd]
---

# Remind facilitator when Crew Retrospective is due

## Problem
A manual retrospective can be forgotten, but a background timer or automatic start could interrupt Members or behave nondeterministically while the Crew is offline; due detection needs a bounded runtime trigger.

## Context
Cadence is advisory scheduling: it may mark a retrospective due, but it cannot start one or change instructions.

## Acceptance criteria
- [ ] Crew manifest may configure bounded retrospective cadence and exact facilitator Member; parsing rejects ambiguous, zero, negative, overflow, or unsupported values.
- [ ] Injected clock computes due from last completed retrospective at documented runtime boundaries; same state/time yields same result.
- [ ] When due, exactly one durable non-interrupting reminder is persisted for facilitator, including recovery/start guidance but no automatic action.
- [ ] Offline facilitator receives reminder later through Inbox; other Members are not selected by Role or liveness fallback.
- [ ] Restart, repeated hooks, clock rollback/jump, already-open round, and concurrent sessions never duplicate reminder or round.
- [ ] Cadence never invokes Member requests, Redirect, Interrupt, Agreement activation, or background polling.
- [ ] Status/CLI can distinguish not-due, due, open, and unavailable-facilitator states without claiming Member availability.
- [ ] Deterministic clock and lifecycle tests cover boundary instants, restart, concurrency, offline handoff, and malformed state.

## Non-goals
Cron daemon, automatic retrospective start, automatic takeover, or calendar provider integration.

