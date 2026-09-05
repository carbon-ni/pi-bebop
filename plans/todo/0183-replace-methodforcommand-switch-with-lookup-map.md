---
id: TASK-0183
title: Replace methodForCommand switch with protocol registry lookup
status: done
depends_on: []
priority: normal
tags: [techdebt, infra, rpc-server, complexity]
---

# Replace methodForCommand switch with protocol registry lookup

## Problem

`methodForCommand` in `src/infra/rpc-server.ts#L47-L100` is a 24-case switch duplicating the command-to-method mapping already owned by the exhaustive `COMMAND_REGISTRY`. It scores complexity 25 while containing zero logic. Every new protocol method risks drift between two mappings.

## Acceptance criteria

- [x] `methodForCommand` delegates to the existing exhaustive `COMMAND_REGISTRY`; no parallel lookup table is introduced.
- [x] Type-checking and a focused test prove every registered `RpcCommand` resolves through the registry with no orphan or missing mapping.
- [x] `methodForCommand` is reduced to a one-line registry read; unknown commands retain the explicit `unknown-command` error path.
- [x] Focused RPC tests, `npm run lint`, and watcher verification pass.

## Notes

Smallest safe change from the 05-09-26 architecture review (`.tmp/reports/05-09-26/architecture-review.md` F2). TASK-0156 already established `COMMAND_REGISTRY` as source of truth; this task removes the remaining duplicate rather than creating another table. Do this before any other rpc-server edit.

Completed at `2317bce`. `src/infra/rpc-server.ts` now reads the existing registry; `src/infra/rpc-server.test.ts` covers every registry command and the existing unknown-command path. Focused tests passed 61/61, `npx tsc --noEmit --pretty false` passed, and Prettier checks passed.
