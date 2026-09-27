---
id: TASK-0249
title: Verify SDK independence and migrated interface boundaries
status: todo
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

- [ ] Import/type/run packed SDK from a clean consumer without Pi runtime startup or internal source imports.
- [ ] In-process entry imports require no socket/discovery/environment context; explicit operation dependencies remain required.
- [ ] Verify import/dependency direction with structural or executable checks, not regex-only documentation tests.
- [ ] Remove only obsolete duplication left by listed migrations; do not rewrite unrelated modules.
- [ ] Record API/ownership map and any intentional CLI/Pi differences, plus instructions for adding another operation.
- [ ] Full configured exact-head gates cover packed CLI, extension and SDK; compare risk/coverage to pre-refactor baseline.

## Non-goals

Separate repositories/npm release, restored TASK-0234 integration tutorial scope, or migrating deferred setup/Guest/session/Intake capabilities. Follow `docs/SDK-REFACTOR.md`.
