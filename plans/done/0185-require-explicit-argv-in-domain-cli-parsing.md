---
id: TASK-0185
title: Require explicit argv in domain CLI parsing
status: done
depends_on: []
priority: normal
tags: [techdebt, domain, purity, cli]
---

# Require explicit argv in domain CLI parsing

## Problem

`isSessionControlRequested` in `src/domain/cli.ts:121` defaults its parameter to `process.argv.slice(2)`. This hides a global environment read inside the domain layer, violating the repo rule "domain has no runtime APIs" and making callers unaware they depend on process state.

## Acceptance criteria

- [x] No `process.*` reference remains in `src/domain/`.
- [x] Every current caller passes argv explicitly; future TypeScript callers cannot omit it.
- [x] Domain purity scan returns no process access or non-`node:path` runtime imports (TASK-0186 documents the sanctioned exception).
- [x] Focused 44/44 domain tests and `npm run lint` pass.

## Evidence

`isSessionControlRequested` now requires `readonly string[]`. `rg -n "process\\.|from ['\"]node:(?!path)|require\\(" src/domain --glob '!*.test.ts' --pcre2` returns no matches.

## Notes

Architecture review F3. Small, independent of TASK-0186 but they together close the domain purity gap found in review.
