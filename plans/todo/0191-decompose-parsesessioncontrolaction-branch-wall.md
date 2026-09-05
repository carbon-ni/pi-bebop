---
id: TASK-0191
title: Decompose parseSessionControlAction branch wall
status: doing
depends_on: [TASK-0185]
priority: normal
tags: [techdebt, domain, complexity, cli-parsing]
---

# Decompose parseSessionControlAction branch wall

## Problem

`parseSessionControlAction` in `src/domain/cli.ts#L55-L102` scores complexity 28 from 19 if-statements and 8 logical operators in 48 LOC. The session-control grammar (action, target, flags) is encoded as a branch cascade, so adding one flag touches the whole cascade and each rule's position is invisible.

## Acceptance criteria

- [x] Grammar dispatch uses an exhaustive action parser table with small named parsers for join, argumentless, Guest, and Inbox grammar.
- [x] Same parse outcomes remain for all current inputs: valid combinations, unknown actions, malformed arguments, and quote errors.
- [x] Characterization tests cover every action family and happy/unhappy Guest grammar before refactoring.
- [x] `parseSessionControlAction` complexity is 4; every extracted action parser is ≤9.
- [x] Focused 46/46 domain tests and `npm run lint` pass.

## Evidence

`ast_complexity_analyzer` reports action parser complexity: main dispatch 4, Inbox 9, Guest 6, join 3, argumentless 2, Guests 2. Pre-existing tokenizer is outside the action branch-wall scope.

## Notes

Architecture review F2. Depends on TASK-0185 because both rewrite the parsing surface of `src/domain/cli.ts` — serialize to avoid churn. Keep it pure: no runtime APIs (the file's argv default is removed by 0185).
