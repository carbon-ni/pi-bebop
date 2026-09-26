---
id: TASK-0232
title: Prevent filesystem Intake tests from hanging CI
status: done
depends_on: []
priority: high
tags: [bug, tests, ci, intake, lifecycle]
---

# Prevent filesystem Intake tests from hanging CI

## Problem

The CI quality gate can finish all application and external-Intake assertions but leave Node workers alive while filesystem Intake tests retain filesystem watcher handles. The resulting `make all` run has no actionable failure and can hang until the workflow is canceled.

## Deliverable

A deterministic lifecycle regression and minimal resource-lifecycle fix, plus a finite CI timeout that preserves failure evidence.

## Scope and approach

- Reproduce the hang under CI-like parallel test concurrency before changing behavior.
- Prove which Intake lifecycle path creates an unowned open handle after close.
- Add a deterministic regression that fails on the unfinished-worker behavior without sleeps-until-green or weaker assertions.
- Preserve Inbox durability, receipts, commit intents, and processed/failed evidence.
- Bound the GitHub quality gate to a finite timeout appropriate for the normal gate duration.

## Acceptance criteria

- [x] Root cause is identified with reproduction evidence and isolated to the filesystem Intake lifecycle.
- [x] A deterministic regression proves no watcher/open handle is created after controller close completes.
- [x] Filesystem Intake behavior and durability guarantees remain unchanged.
- [x] CI uses a finite timeout with actionable timeout evidence.
- [x] Repeated parallel full-suite runs pass without orphan workers.
- [x] A fresh exact-head watcher gate and GitHub checks pass.

## Non-goals

Changing Intake routing, durability semantics, message validation, test assertions, or unrelated task work.
