---
id: TASK-0189
title: Flatten restore in guest admission runtime
status: done
depends_on: []
priority: normal
tags: [techdebt, infra, complexity, guest, restore]
---

# Flatten restore in guest admission runtime

## Problem

`restore` in `src/infra/guest-admission-runtime.ts` scored complexity 27 with nesting depth 5 (14 logical operators inside a for-in loop). Deeply nested restore logic hid which branch-state combinations survive a reload, making the startup-restore contract hard to audit.

## Acceptance criteria

- [x] Per-record restore extracted to a named function; loop body is a single call with explicit error handling (`restoreOne` dispatch; loop = single call + outcome push).
- [x] Branch-state preservation rules identical — tombstone/denied/revoked/approved semantics pinned by new characterization tests (invalid candidates → "unknown"; foreign-crew record → rejected by identity; unauthorized approver → rejected; malformed digest → rejected, 64-hex digest → restored; capability-bind throw → rejected, revoked tombstone restores without binding) plus pre-existing tombstone/replay tests, all unmodified.
- [x] Existing guest admission integration tests pass unmodified; extracted functions have direct unit tests.
- [x] Max nesting ≤ 2, cyclomatic complexity ≤ 10 per function (verified: `restoreOne` 6/1, `restoreMembershipRecord` 6/2, `readRestoreCandidate` 6/1, `isRestorableMembershipRecord` 5/0, `approvedRestoreState` ≤5, `restoreDeniedSnapshot` ≤5; old `restore` 27/5 gone).
- [x] `npm test`, `npm run lint` pass.

## Evidence

- Code commit: `e3f0d83` on `dev-next` (against 42c9863; Mary's referenced base 1125ec2 was an ancestor — tree advanced during the task).
- Focused: 12/12 unit, 11/11 guest-registry integration, 33/33 combined focused suite.
- Watcher quality gate `make all` PASS gen=967 (one stale `.bebop-build.lock` from dead PID 7707 removed first — concurrent-build artifact, not code).
- TDD order: characterization tests written and green against pre-refactor code BEFORE extraction; refactor kept them green unmodified.
- Out-of-scope note: `receive` (c=16) untouched — separate concern. `verify:cli` remains flaky due to the coverage-gate noise band — now owned by TASK-0193 with evidence.

## Notes

Unblocks TASK-0187 (extension composition split) per Mary's sequencing.
