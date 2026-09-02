---
id: TASK-0129
title: Persist the trusted Crew Message Log
status: done
depends_on: [TASK-0128]
priority: high
tags: [crew, messaging, evidence, storage, security, concurrency, retention, tdd]
---

# Persist the trusted Crew Message Log

## Problem

The Crew Message Log needs deterministic project-local storage that survives restarts without turning message delivery into a fragile or unbounded audit pipeline.

## Context

Implement only the trusted storage boundary from TASK-0128. Do not wire live messaging adapters or add read tools/commands in this task. Follow the active manifest layout exactly; never create parallel `.pi/bebop` and `.pi/crew` logs for one Crew.

## Product scope decision

Exact-SHA matrix QA of `1ca0a4bf` confirmed the trusted append boundary but found that age-retention/pruning metadata, lifecycle markers/checkpoint query, and volatile gap-ledger merge/persistence were not integrated. Product first reopened TASK-0129, then explicitly moved those integrity requirements to follow-up TASK-0150 instead of claiming they were implemented. TASK-0130 depends on TASK-0150 so live capture cannot build on the deferred boundary.

The scoped TASK-0129 implementation is accepted with `.watch.yaml` concurrency 1, exact detached QA, and clean candidate-path formatting. The unchanged crew-board test formatting defect is pre-existing and not a TASK-0129 regression.

## Acceptance criteria

- [x] Tests cover the accepted store boundary: missing/empty store, first append, exact replay, conflicting replay, concurrent writers, corruption, quarantine, full capacity, unsafe paths/symlinks, both supported Crew layouts, and injected failures.
- [x] One canonical manifest-adjacent store persists immutable, schema-valid Log Entries with stable IDs and canonical bytes; a missing read creates no files or directories.
- [x] Trust and supported-layout validation happen before manifest/log IO; traversal, symlink escape, foreign layout, unsafe IDs, and untrusted projects fail without mutation.
- [x] Publication is lock-protected, atomic, durable, and no-replace. Exact replay is idempotent; same ID with different bytes is an explicit conflict and never overwrites evidence.
- [x] Lock acquisition has one bounded deadline and deterministic cleanup. No stale-lock age guessing or lock stealing can permit concurrent writers.
- [x] Age retention, deterministic pruning, and explicit retained-gap metadata are deferred to TASK-0150 and are not claimed implemented here.
- [x] Lifecycle markers and the bounded per-endpoint checkpoint/close query are deferred to TASK-0150 and are not claimed implemented here.
- [x] Volatile gap-ledger merge and durable recovery are deferred to TASK-0150 and are not claimed implemented here.
- [x] Malformed entries are boundedly quarantined without blocking healthy entries; quarantine cannot grow without the contract's cap or become readable message evidence.
- [x] Injected filesystem, clock, and ID/hash dependencies make byte output and boundary races deterministic. Store code has no Pi, tool, CLI, network, provider, or delivery dependency.
- [x] Storage append reports evidence persistence separately from the original messaging outcome. Its API cannot send, redirect, acknowledge, mark read, mutate Inbox/Crew Board/Agreements, or infer meaning.
- [x] Package/export wiring, focused coverage, concurrency stress, architecture gate, and watcher final gate pass with no secret/path leakage in errors for the accepted scope.

## Non-goals

Live message capture, Member authentication/application authorization, review/query surfaces, analytics, Retrospective synthesis, Git/network synchronization, or modifying existing Inbox/Crew Board stores.
