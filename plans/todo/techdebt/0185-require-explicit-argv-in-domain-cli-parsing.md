---
id: TASK-0185
title: Require explicit argv in domain CLI parsing
status: todo
depends_on: []
priority: normal
tags: [techdebt, domain, purity, cli]
---

# Require explicit argv in domain CLI parsing

## Problem

`isSessionControlRequested` in `src/domain/cli.ts:121` defaults its parameter to `process.argv.slice(2)`. This hides a global environment read inside the domain layer, violating the repo rule "domain has no runtime APIs" and making callers unaware they depend on process state.

## Acceptance criteria

- [ ] No `process.*` reference remains in `src/domain/`.
- [ ] All callers (found via `parseSessionControlAction` consumers in `src/pi/control-commands.ts`) pass argv explicitly.
- [ ] Domain purity scan is clean: `rg "process\.|node:|require\(" src/domain/ --glob '!*test*'` returns only the sanctioned `node:path` imports (TASK-0186).
- [ ] `npm test`, `npm run lint` pass.

## Notes

Architecture review F3. Small, independent of TASK-0186 but they together close the domain purity gap found in review.
