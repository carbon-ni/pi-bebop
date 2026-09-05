---
id: TASK-0191
title: Decompose parseSessionControlAction branch wall
status: todo
depends_on: [TASK-0185]
priority: normal
tags: [techdebt, domain, complexity, cli-parsing]
---

# Decompose parseSessionControlAction branch wall

## Problem

`parseSessionControlAction` in `src/domain/cli.ts#L55-L102` scores complexity 28 from 19 if-statements and 8 logical operators in 48 LOC. The session-control grammar (action, target, flags) is encoded as a branch cascade, so adding one flag touches the whole cascade and each rule's position is invisible.

## Acceptance criteria

- [ ] Grammar decomposed into ordered small parsers or a declarative token table (action keyword, session target, mode/wait flags).
- [ ] Same parse outcomes for all current inputs: valid combinations, unknown actions, malformed flags.
- [ ] Direct unit tests per grammar element plus the full current acceptance fixtures.
- [ ] Cyclomatic complexity of every resulting function ≤ 10.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Architecture review F2. Depends on TASK-0185 because both rewrite the parsing surface of `src/domain/cli.ts` — serialize to avoid churn. Keep it pure: no runtime APIs (the file's argv default is removed by 0185).
