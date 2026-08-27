---
id: TASK-0099
title: Table-driven command codec in protocol.ts
status: todo
depends_on: [TASK-0098]
priority: high
tags: []
---

# Table-driven command codec in protocol.ts

## Problem
domain/protocol.ts hand-maps every RPC command symmetrically in requestToCommand (cyclomatic 50) and commandToRequest (cyclomatic 25), 1293-line file. Adding a command means mirrored edits in two long if-chains plus the dispatcher plus the registry: four hot files per feature. TypeBox schemas for commands already exist and can drive a single table.

## Context
From the 13-04-26 arch review (`.tmp/reports/13-04-26/codebase-map.md`, finding F3). Depends on TASK-0098 because handler extraction defines the seam; do after. Approach: table-driven per-command codec `{ command, method, encode, decode }` built on existing TypeBox schemas; keep `requestToCommand` and `commandToRequest` as facades so call sites don't move.

## Acceptance criteria
- [ ] Single table drives both directions; both original functions remain exported as facades over the table.
- [ ] Protocol round-trip tests stay green, plus property-style round-trip coverage for every registered command (command → request → command).
- [ ] `requestToCommand`/`commandToRequest` facade complexity under 10; table rows are data, not logic.
- [ ] `npm test` and `npm run lint` green.

## Non-goals
- No wire-format or schema changes.
- No behavior changes to validation errors.

## Notes
Full report: `.tmp/reports/13-04-26/codebase-map.md`.
