---
id: TASK-0157
title: Split protocol.ts into domain/protocol/ modules
status: done
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

- [x] No file under `src/domain/protocol/` exceeds 500 lines.
- [x] `rg "from .*domain/protocol\.ts" src` returns nothing (barrel removed
      or no direct deep imports outside domain).
- [x] Full test suite green; no test file edits needed except import paths.
- [x] `npm run lint` and coverage gates stay green.

## Non-goals

No schema or wire changes, no renaming of exported types.

## Context
(Optional: approach, links, related tasks.)

## Notes

- 2026-09-04: Coordinator remains sole implementation owner under Mary's
  authorization for the TASK-0155 onward sequence.
- 2026-09-04: Implemented in `01810d6`; package whitelist and explicit stable
  barrel export fixes in `44e8c29`. Full `npm test` passed (1169 tests),
  `npm run verify:cli` passed (95.84% lines, 90.07% branches), and watcher
  generation 724 passed the fresh `@agent-final` gate. Mary approved exact-head
  closure; package verification passed with an ignored nested `.pi` artifact.

