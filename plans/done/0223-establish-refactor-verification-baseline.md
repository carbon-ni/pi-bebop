---
id: TASK-0223
title: Establish refactor verification baseline
status: done
depends_on: []
priority: high
tags: [refactor, verification, regression]
---

# Establish refactor verification baseline

## Problem

The architecture review of `b199de7` observed watcher generation 1 with 1,434 passing tests and one failure. The retained tail did not identify the failed test. A later planning-time watcher snapshot reported PASS (also generation 1), but watcher-instance continuity and matching worktree freshness were not established. Starting behavior-preserving refactors without reconciling this evidence would make regression attribution unreliable. This task verifies the current baseline; it does not assume the failure persists.

## Deliverable

A verified baseline with the failure identified, its cause recorded, and a focused correction if needed. This is verification work, not an architecture rewrite.

## Scope and approach

- Observe current watcher state first; historical generation numbers are not a current freshness guarantee.
- Retrieve failing-test evidence from the exact generation. If evidence is unavailable, use watcher targets to choose a fresh verification run.
- Distinguish product defect, test scheduling assumption, environment failure, and obsolete evidence. Do not assume the intake polling tests caused the failure.
- Add a reproducing test before a code correction where applicable. Do not weaken assertions or retry until green as a substitute for diagnosis.

## Acceptance criteria

- [ ] Record failing test, command, revision, and evidence, or explicitly explain why historical failure cannot be recovered and record fresh results.
- [ ] Any reproducible failure is corrected with a bounded change and a regression test, or this task remains open with a concrete blocker.
- [ ] The configured final watcher gate passes with fresh worktree evidence; no blanket skips or reduced coverage thresholds.
- [ ] Record focused verification commands and baseline coverage relevant to subsequent deliverables; do not equate test-file counts with coverage.

## Non-goals

Implementing the refactors, changing public behavior to satisfy tests, or fixing unrelated infrastructure without first identifying the failure.
