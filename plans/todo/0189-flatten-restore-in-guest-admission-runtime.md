---
id: TASK-0189
title: Flatten restore in guest admission runtime
status: todo
depends_on: []
priority: normal
tags: [techdebt, infra, complexity, guest, restore]
---

# Flatten restore in guest admission runtime

## Problem

`restore` in `src/infra/guest-admission-runtime.ts#L392-L465` scores complexity 27 with nesting depth 5 (14 logical operators inside a for-in loop). Deeply nested restore logic hides which branch-state combinations survive a reload, making the startup-restore contract hard to audit.

## Acceptance criteria

- [ ] Per-record restore extracted to a named function; loop body is a single call with explicit error handling.
- [ ] Branch-state preservation rules (reload/resume keeps state, new/fork discards) remain identical.
- [ ] Existing guest admission integration tests pass unmodified; extracted function has direct unit tests for happy and unhappy paths.
- [ ] Max nesting depth ≤ 2, cyclomatic complexity per function ≤ 10.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Architecture review F2. Related family: TASK-0187 touches guest composition wiring — land 0189 first to avoid churn in the same area.
