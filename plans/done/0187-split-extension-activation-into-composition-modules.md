---
id: TASK-0187
title: Split extension.ts activation into composition modules
status: done
depends_on: []
priority: high
tags: [techdebt, pi, composition, refactor]
---

# Split extension.ts activation into composition modules

## Problem

`src/extension.ts` held a single 566-line activation closure (L84–L650). Guest membership, guest admission authorization, membership runtime, presence observer, session lifecycle callbacks, and inbox bridge wiring all lived inline in one function. Every wiring change edited the same giant function.

## Acceptance criteria

- [x] Guest membership + admission wiring extracted to `src/pi/guest-composition.ts` (`createGuestComposition`: guest runtime creation, admission registry refresh, approved-guest reads, guest manifest loading, messaging tool registration, control command registration).
- [x] Membership + session lifecycle wiring extracted to `src/pi/session-lifecycle-composition.ts` (`wireMembershipRuntime`, `createMembershipRecording`, `registerSessionLifecycle` for session_start / before_agent_start / session_shutdown / turn_end / agent_settled / compaction_end).
- [x] `src/extension.ts` reduced 650 → 260 lines (target under ~300). All modules under 500 lines (guest-composition 199, session-lifecycle-composition 305).
- [x] Follows `presence-composition.ts` shape: dependency wiring only, no behavior change — handler bodies moved verbatim; runtime creation order (guest → membership) and registration order (session control command → guest control command → handlers) preserved.
- [x] No functional change: existing extension-loading, control-runtime, guest-control, membership, and integration tests pass unmodified; zero test files touched.
- [x] `npm test` (1199/0), `npm run lint`, format green; watcher quality gate `make all` PASS gen=979.

## Evidence

- Commits: `b304f19` (split) + `7955237` (path-revert of a teammate's in-flight files that a concurrent `git add` raced into b304f19 — their working-tree files untouched; no amend).
- Focused: 78/78 extension+runtime+membership unit, 18/18 guest-admission/inbox/idle integration.
- `verify:cli` remains flaky pre-existing (coverage noise band) — owned by TASK-0193, untouched here per instruction.

## Notes

Prerequisites TASK-0184 + TASK-0189 were already done. Next natural step: none required; extension.ts is now navigable per subsystem.
