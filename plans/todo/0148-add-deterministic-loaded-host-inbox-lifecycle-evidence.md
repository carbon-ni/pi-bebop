---
id: TASK-0148
title: Add deterministic loaded-host Inbox lifecycle evidence
status: doing
depends_on: [TASK-0129, TASK-0147]
priority: high
tags: [crew, inbox, broadcast, lifecycle, integration, qa]
---

# Add deterministic loaded-host Inbox lifecycle evidence

## Readiness note

Product re-closed scoped TASK-0129 transparently and authorized this task as the
next priority. TASK-0150 is tracked separately for deferred Message Log
retention/recovery integrity.

## Problem

TASK-0147 was accepted under a narrow waiver for missing loaded-host evidence.
The remaining integration risk must be tracked explicitly rather than silently
remaining in the completed task.

## Desired outcome

A deterministic loaded-extension host harness proves the waived paths without
wall-clock polling or duplicated production internals.

## Acceptance criteria

- [ ] Loaded extension composition drives a real joined recipient through
      busy-to-settled and real compaction terminal success/failure events.
- [ ] Automatic restore/join, pause/resume, evidence reconciliation, and
      Broadcast retry are exercised through production lifecycle triggers.
- [ ] Public `broadcast_to_crew` reaches the target's real control socket and
      produces exactly one typed FIFO Follow-up with deterministic ID/content.
- [ ] Tests use explicit completion signals, prove durable-first persistence,
      authoritative idle/compaction gating, and no duplicate/loss.
- [ ] Focused tests, typecheck, formatting, architecture checks, fresh
      candidate-bound watcher evidence, and independent exact-head QA pass.

## Non-goals

- Changing TASK-0147 product semantics or its accepted durable Inbox behavior.
- Wall-clock delivery guarantees, polling sleeps, or claims of read/completion.
