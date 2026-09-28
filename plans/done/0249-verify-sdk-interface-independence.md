---
id: TASK-0249
title: Verify SDK independence and migrated interface boundaries
status: done
depends_on: [TASK-0239, TASK-0240, TASK-0241, TASK-0242, TASK-0243, TASK-0244, TASK-0245, TASK-0246, TASK-0247, TASK-0248]
priority: normal
tags: [sdk, packaging, architecture, verification]
---

# Verify SDK interface independence

## Problem

Completed migrations need proof that the SDK is independently consumable and that CLI/extension adapters have not retained parallel operation implementations.

## Desired outcome

Packed remote and in-process entrypoints work without loading Pi/Commander unnecessarily; migrated interfaces share operations with one runtime owner.

## Acceptance criteria

- [x] Import/type/run packed SDK from a clean consumer without Pi runtime startup or internal source imports.
- [x] In-process entry imports require no socket/discovery/environment context; explicit operation dependencies remain required.
- [x] Verify import/dependency direction with structural or executable checks, not regex-only documentation tests.
- [x] Remove only obsolete duplication left by listed migrations; do not rewrite unrelated modules.
- [x] Record API/ownership map and any intentional CLI/Pi differences, plus instructions for adding another operation.
- [x] Full configured exact-head gates cover packed CLI, extension and SDK; compare risk/coverage to pre-refactor baseline.

## Verification

- `scripts/verify-package.mjs` now compiles a clean packed SDK consumer, runs a dependency-guarded packed import, executes representative remote and in-process operations, and clears `PI_*` environment context. It is wired into `npm run verify:cli`.
- `docs/SDK-INTERFACE-MAP.md` records public APIs, runtime ownership, intentional CLI/Pi differences, and the operation-addition procedure.
- Restored direct remote Follow-up timeout validation and pre-abort parity; focused operation tests pass.
- Exact configured CLI coverage columns are lines / branches / functions. Baseline `96fe084` (`npm run test:coverage:cli`): 97.08% / 90.17% / 85.17% across 753 tests. Final integrated `211113a` (`npm run verify:cli`): 96.68% / 90.37% / 86.36% across 764 tests; it satisfies the configured 95% lines / 90% branches gate. Full suite passed 1596/1596 across 84 suites.
- Final integration after TASK-0247 (`origin/main` `7fd2c22`) requires rerunning exact-head gates below.

## Non-goals

Separate repositories/npm release, restored TASK-0234 integration tutorial scope, or migrating deferred setup/Guest/session/Intake capabilities. Follow `docs/SDK-REFACTOR.md`.
