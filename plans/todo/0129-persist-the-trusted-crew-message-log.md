---
id: TASK-0129
title: Persist the trusted Crew Message Log
status: todo
depends_on: [TASK-0128]
priority: high
tags: [crew, messaging, evidence, storage, security, concurrency, retention, tdd]
---

# Persist the trusted Crew Message Log

## Problem

The Crew Message Log needs deterministic project-local storage that survives restarts without turning message delivery into a fragile or unbounded audit pipeline.

## Context

Implement only the trusted storage boundary from TASK-0128. Do not wire live messaging adapters or add read tools/commands in this task. Follow the active manifest layout exactly; never create parallel `.pi/bebop` and `.pi/crew` logs for one Crew.

## Acceptance criteria

- [ ] Tests first cover missing/empty store, first append, exact replay, conflicting replay, concurrent writers, restart, corruption, quarantine, retention, full capacity, unsafe paths/symlinks, both supported Crew layouts, epoch open/checkpoint/clean close, recovered/unclean gaps, and injected failures.
- [ ] One canonical manifest-adjacent store persists immutable, schema-valid Log Entries with stable IDs and canonical bytes; a missing read creates no files or directories.
- [ ] Trust and supported-layout validation happen before manifest/log IO; traversal, symlink escape, foreign layout, unsafe IDs, and untrusted projects fail without mutation.
- [ ] Publication is lock-protected, atomic, durable, and no-replace. Exact replay is idempotent; same ID with different bytes is an explicit conflict and never overwrites evidence.
- [ ] Lock acquisition has one bounded deadline and deterministic cleanup. No stale-lock age guessing or lock stealing can permit concurrent writers.
- [ ] Retention applies TASK-0128's age plus capacity bounds under the same lock with deterministic pruning order and explicit retained gap/pruning metadata; no read path performs hidden cleanup.
- [ ] Epoch-open, coverage-checkpoint, clean-close, recovered-gap, and unverified-capture markers use the same immutable/replay rules as message events. Per-endpoint last durable checkpoint/close is queryable without treating absent markers as proof of no activity.
- [ ] Store recovery accepts the injected bounded volatile gap ledger, persists stable merged ranges before the next event/checkpoint in one lock boundary, and reports conflicts without dropping or widening an already durable range.
- [ ] Malformed entries are boundedly quarantined without blocking healthy entries; quarantine cannot grow without the contract's cap or become readable message evidence.
- [ ] Injected filesystem, clock, and ID/hash dependencies make byte output and boundary races deterministic. Store code has no Pi, tool, CLI, network, provider, or delivery dependency.
- [ ] Storage append reports evidence persistence separately from the original messaging outcome. Its API cannot send, redirect, acknowledge, mark read, mutate Inbox/Crew Board/Agreements, or infer meaning.
- [ ] Package/export wiring, focused coverage, concurrency stress, architecture gate, and watcher final gate pass with no secret/path leakage in errors.

## Non-goals

Live message capture, Member authentication/application authorization, review/query surfaces, analytics, Retrospective synthesis, Git/network synchronization, or modifying existing Inbox/Crew Board stores.
