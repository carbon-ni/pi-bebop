---
id: TASK-0150
title: Complete Crew Message Log retention and recovery integrity
status: blocked
depends_on: [TASK-0129]
priority: high
tags: [crew, messaging, evidence, retention, lifecycle, recovery, storage, tdd]
---

# Complete Crew Message Log retention and recovery integrity

## Problem

The accepted Crew Message Log store provides trusted atomic append and bounded capacity, but it does not yet implement the original age-retention evidence, lifecycle coverage markers, or volatile-gap recovery needed to make later capture and review evidence honest across pruning and restarts.

## Context

This is the explicit follow-up for TASK-0129 acceptance criteria deferred by Product after exact-SHA matrix QA of `1ca0a4bf`. Historical implementations on isolated TASK-0129 branches are reference material only; integrate reviewed behavior into the current store rather than treating unmerged commits or green unit tests as production evidence. TASK-0130 must not capture live outcomes until this task is complete.

## Current disposition

Parked and unaccepted while TASK-0148 is active. Preserve reference commits
`593ac23` and `6fb567f` without expanding them. Resume only after TASK-0148
exact-head QA PASS and closure, then obtain a fresh full-matrix QA round.

## Acceptance criteria

- [ ] Tests fail first for strict age cutoff, equality retention, age/capacity interaction, deterministic pruning order, retained gaps, restart, concurrent writers, and injected publication failures.
- [ ] Age plus capacity retention runs under the same append lock and publishes explicit stable pruning/retained-gap metadata before the incoming record; read paths perform no cleanup.
- [ ] Pruning never silently drops evidence, resurrects removed entries after rollback, or overwrites replay/conflict identity. Ordering derives from canonical `(occurredAt, id)` fields rather than directory enumeration.
- [ ] Epoch-open, coverage-checkpoint, clean-close, recovered-gap, and unverified-capture markers use closed schemas, canonical immutable bytes, replay idempotency, and explicit identity conflict in both supported Crew layouts.
- [ ] A bounded per-endpoint query returns the last durable checkpoint/close without treating an absent marker as proof of no activity and without mutating storage.
- [ ] Store recovery accepts an injected ledger of at most 256 volatile ranges, merges stable ranges deterministically, and persists them before the next event or checkpoint within one lock boundary.
- [ ] Gap replay/conflict cannot drop or widen an already durable range. Crash, restart, lock contention, filesystem failure, and partial publication remain explicit and preserve healthy evidence.
- [ ] Current production append paths consume the retention, marker, and recovery operations. Source/use tests prove the behavior is not isolated in unused planners, snapshots, or test-only modules.
- [ ] Public errors remain bounded and reveal no message content, absolute paths, sockets, lock tokens, stacks, or raw dependency failures.
- [ ] Focused coverage, concurrency stress, both-layout integration, package/export verification, architecture gate, and a clean exact-head watcher final gate pass with independent QA.

## Non-goals

Live message capture, review/query tools beyond the bounded internal checkpoint lookup, analytics, Retrospective synthesis, or changing Inbox/Crew Board/Agreement semantics.

