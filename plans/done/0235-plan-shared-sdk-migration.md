---
id: TASK-0235
title: Plan shared SDK migration for CLI and Pi extension
status: done
depends_on: []
priority: high
tags: [sdk, architecture, planning]
---

# Plan shared SDK migration

## Problem

Three public interfaces duplicate transport and result handling. The current remote-only SDK cannot serve Pi tools without self-RPC.

## Desired outcome

A dependency-ordered set of small migrations shares SDK operations while keeping one runtime state owner and each interface's native behavior.

## Acceptance criteria

- [x] `docs/SDK-REFACTOR.md` records current-main evidence, target dependency direction, and invariants.
- [x] Each deliverable has a task, dependencies, observable acceptance criteria and non-goals.
- [x] First implementation is bounded to read-only status contracts/adapters; CLI and Pi adoption have separate tasks.
- [x] Existing authority, cancellation, effect uncertainty, Guest restrictions, and Pi wake/yield behavior are explicit.
- [x] TASK-0179 and withdrawn TASK-0234 are excluded from implementation scope.

## Verification

Run the kanban dependency-cycle check and review all new tasks against the roadmap. This planning task changes no runtime code. Each implementation task requires its own exact-head verification.
