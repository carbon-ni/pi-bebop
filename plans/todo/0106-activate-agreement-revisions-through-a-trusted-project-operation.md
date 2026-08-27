---
id: TASK-0106
title: Activate Agreement revisions through a trusted project operation
status: todo
depends_on: [TASK-0104, TASK-0105]
priority: high
tags: [crew-agreements, cli, activation, security, atomicity, tdd]
---

# Activate Agreement revisions through a trusted project operation

## Problem
A Member message, Role, or retrospective facilitator must not gain authority to mutate system instructions; the Crew needs an explicit atomic boundary for making one Agreement revision current and announcing the change.

## Context
Activation is separate from proposal and retrospective coordination because agreement content becomes shared system instruction.

## Acceptance criteria
- [ ] Operator-facing command activates one candidate Agreement revision explicitly; no membership tool, Role, Origin, Message instruction, or facilitator status can activate it.
- [ ] Preflight verifies candidate integrity and exact current base revision before any write; stale, missing, corrupt, or already-conflicting state fails atomically with stable code.
- [ ] Activation atomically changes Current Crew Agreements and immutable revision state; exact rerun is an unchanged success.
- [ ] Active Membership snapshots remain unchanged; activated revision applies only on next join/restore.
- [ ] After durable activation, Crew Broadcast announces bounded revision metadata to every other Member without exposing private proposal evidence.
- [ ] Broadcast partial failure cannot roll back activated instructions and is reported honestly per recipient without duplicate activation.
- [ ] TOON/JSON/text output exposes revision ID, prior revision, disposition, and actionable next steps without leaking absolute/private paths.
- [ ] Happy/unhappy tests prove authority boundary, zero-write failures, idempotency, concurrency, snapshot stability, and broadcast outcomes.

## Non-goals
Crew voting, automatic activation, hot reload, or editing revision bytes in place.

