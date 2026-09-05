---
id: TASK-0187
title: Split extension.ts activation into composition modules
status: todo
depends_on: []
priority: high
tags: [techdebt, pi, composition, refactor]
---

# Split extension.ts activation into composition modules

## Problem

`src/extension.ts` holds a single 566-line activation closure (`export default` L84–L650). Guest membership, guest admission authorization, membership runtime, presence observer, session lifecycle callbacks, and inbox bridge wiring all live inline in one function. Every wiring change edits the same giant function; navigation and review cost grow with each subsystem, and merge conflicts concentrate there.

## Acceptance criteria

- [ ] Guest membership + admission wiring extracted to `src/pi/guest-composition.ts` (or similarly named), taking `pi` and shared socket state.
- [ ] Membership + session lifecycle wiring extracted to its own composition module.
- [ ] `src/extension.ts` default function reduced to sequential composition calls plus flag/renderer registration — target under ~300 lines total.
- [ ] Follow the existing `src/pi/presence-composition.ts` shape: dependency wiring only, no behavior change.
- [ ] No functional change: existing extension-loading and integration tests pass unmodified.
- [ ] `npm test`, `npm run lint`, `npm run verify:cli` pass.

## Notes

Architecture review F1 (P1). Extraction only — if a block needs logic changes, that is a separate task. Land after TASK-0184 to avoid rebasing startup-send edits.
