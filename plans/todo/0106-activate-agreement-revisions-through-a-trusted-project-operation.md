---
id: TASK-0106
title: Activate Agreement revisions through a trusted project operation
status: doing
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
- [ ] Activation atomically changes Current Crew Agreements and immutable revision state; exact rerun is unchanged only while that exact revision is already current, while a later/different current revision makes the candidate stale/conflicting.
- [ ] Active Membership snapshots remain unchanged; activated revision applies only on next join/restore.
- [ ] After durable activation, Bebop enqueues one bounded Agreement activation notice through each configured Member's Inbox without exposing credentials, raw evidence, or unbounded proposal content; this system-produced fan-out is not Crew Broadcast because no Current member initiated it.
- [ ] Notice enqueue partial failure cannot roll back activated instructions and is reported honestly per Member without duplicate activation.
- [ ] TOON/JSON/text output exposes revision ID, prior revision, disposition, and actionable next steps without leaking unsafe absolute paths or secrets.
- [ ] Happy/unhappy tests prove authority boundary, zero-write failures, exact-current idempotency, concurrency, snapshot stability, and Agreement activation notice enqueue outcomes.

## Non-goals
Crew voting, automatic activation, hot reload, or editing revision bytes in place.

