---
id: TASK-0149
title: Add bounded durable Inbox lifecycle diagnostics
status: todo
depends_on: [TASK-0148]
priority: high
tags: [crew, inbox, broadcast, lifecycle, diagnostics, observability, privacy, tdd]
---

# Add bounded durable Inbox lifecycle diagnostics

## Problem
When an Inbox or Broadcast item remains pending, is offered late, or appears duplicated, operators cannot reconstruct which recipient boundary observed it or why the bridge skipped/offered/reconciled it. The waived TASK-0147 production paths need privacy-safe, persistent traces that make lifecycle failures diagnosable without exposing message content or socket paths.

## Context

This follows TASK-0148 because the traces must describe tested production
boundaries rather than become a second delivery mechanism. Diagnostics are
recipient-owned observation records. They never decide delivery, retry it, or
change the persisted Inbox disposition.

## Diagnostic record

Persist a typed, bounded session-entry record for each lifecycle observation:

- stable `itemId` and optional `broadcastId` / sender operation ID;
- safe recipient identity (manifest member name and role only);
- trigger: `inbox_hint`, `session_start`, `agent_settled`,
  `session_compact`, `session_compact_failed`, `turn_end`, `resume`;
- decision: `offered`, `retained`, `reconciled`, `paused`, `skipped`, or
  `failed`;
- bounded reason/code, authoritative idle/compacting state, and a deterministic
  monotonic sequence.

Records must never contain Inbox message content, instructions, raw payloads,
socket paths, provider output, stack traces, or unbounded errors. Keep a fixed
recent window per session and make the window/retention explicit.

## Acceptance criteria
- [ ] The bridge records durable-first persistence/hint outcome and every
      recipient offer decision at actual production triggers, including busy,
      compaction success/failure, restore/join, pause/resume, evidence
      reconciliation, and retry.
- [ ] A support-facing read surface (`/crew inbox status` or a bounded
      diagnostics command) returns recent records in trigger order with safe
      IDs/reasons, without message content or filesystem/socket details.
- [ ] The diagnostic record is persisted with the session so a restart preserves
      enough evidence to explain the next reconciliation/offer decision.
- [ ] The trace is observational only: disabling, recording failure, full trace
      capacity, or rendering failure never blocks persistence, notification,
      reconciliation, or one FIFO Follow-up offer.
- [ ] Deterministic tests use injected clock/sequence and explicit completion
      signals; they prove bounded retention, redaction, trigger-to-decision
      ordering, and no duplicate trace for one serialized offer decision.
- [ ] Loaded-host tests from TASK-0148 assert useful traces for public Broadcast
      idle, busy-to-settled, compaction, restore/join, pause/resume, and
      evidence/retry paths.
- [ ] Focused tests, typecheck, formatting, architecture checks, fresh
      candidate-bound watcher evidence, and independent exact-head QA pass.

## Notes

No log line implies recipient read, understood, completed, or answered an item.

