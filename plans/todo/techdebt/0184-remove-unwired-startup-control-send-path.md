---
id: TASK-0184
title: Remove unwired startup control send path
status: todo
depends_on: []
priority: normal
tags: [techdebt, pi, dead-code, startup-send]
---

# Remove unwired startup control send path

## Problem

`maybeHandleStartupControlSend` in `src/pi/startup-send.ts#L417-L511` (95 LOC, complexity 20) is referenced only by its colocated tests. AGENTS.md confirms it "is not currently wired into composition". The repo maintains and tests behavior nothing uses, and readers assume a live startup-send path exists.

## Acceptance criteria

- [ ] `maybeHandleStartupControlSend` and its tests are deleted, or wired into `src/extension.ts` composition with an explicit decision recorded in this task.
- [ ] If deleted: no remaining references; `startup-send.ts` exports only wired code.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Default to deletion (smaller churn). If wiring is chosen, update AGENTS.md's "not currently wired" note. Architecture review F5.
