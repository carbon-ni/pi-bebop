---
id: TASK-0157
title: Split protocol.ts into domain/protocol/ modules
status: todo
depends_on: [TASK-0156]
priority: normal
tags: [refactor, protocol]
---

# Split protocol.ts into domain/protocol/ modules

## Problem

src/domain/protocol.ts is 1261 lines mixing wire schemas, command/request
mapping, event types, and helpers. The 500-line guardrail flags it; the file
is the highest fan-in module in the codebase (imported by 46 files) so changes
cause broad churn.

## Desired outcome

`src/domain/protocol/` with focused modules (e.g. `wire-schemas.ts`,
`command-registry.ts`, `events.ts`, `messages.ts`) plus an index barrel so the
46 importing files keep working through `domain/index.ts` re-exports.

## Approach

1. Depends on TASK-0156: mapping logic already registry-shaped, so
   `command-registry.ts` moves as one unit.
2. Move in dependency order: wire schemas first, then events, then registry;
   keep `src/domain/protocol.ts` as a re-export barrel during the move if it
   reduces churn, delete it once importers are updated.
3. Respect the domain-barrel rule: external imports go through
   `src/domain/index.ts` only.

## Acceptance criteria

- [ ] No file under `src/domain/protocol/` exceeds 500 lines.
- [ ] `rg "from .*domain/protocol\.ts" src` returns nothing (barrel removed
      or no direct deep imports outside domain).
- [ ] Full test suite green; no test file edits needed except import paths.
- [ ] `npm run lint` and coverage gates stay green.

## Non-goals

No schema or wire changes, no renaming of exported types.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

