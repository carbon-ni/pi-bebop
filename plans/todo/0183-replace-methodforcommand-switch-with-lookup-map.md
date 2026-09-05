---
id: TASK-0183
title: Replace methodForCommand switch with protocol registry lookup
status: doing
depends_on: []
priority: normal
tags: [techdebt, infra, rpc-server, complexity]
---

# Replace methodForCommand switch with protocol registry lookup

## Problem

`methodForCommand` in `src/infra/rpc-server.ts#L47-L100` is a 24-case switch duplicating the command-to-method mapping already owned by the exhaustive `COMMAND_REGISTRY`. It scores complexity 25 while containing zero logic. Every new protocol method risks drift between two mappings.

## Acceptance criteria

- [ ] `methodForCommand` delegates to the existing exhaustive `COMMAND_REGISTRY`; no parallel lookup table is introduced.
- [ ] Type-checking or a focused test proves every `RpcCommand` type resolves through the registry with no orphan or missing mapping.
- [ ] `methodForCommand` is deleted or reduced to a one-line registry read with explicit unknown-command error.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Smallest safe change from the 05-09-26 architecture review (`.tmp/reports/05-09-26/architecture-review.md` F2). TASK-0156 already established `COMMAND_REGISTRY` as source of truth; this task removes the remaining duplicate rather than creating another table. Do this before any other rpc-server edit.
