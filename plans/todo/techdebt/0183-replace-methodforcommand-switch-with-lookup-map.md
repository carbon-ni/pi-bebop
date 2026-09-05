---
id: TASK-0183
title: Replace methodForCommand switch with a lookup map
status: todo
depends_on: []
priority: normal
tags: [techdebt, infra, rpc-server, complexity]
---

# Replace methodForCommand switch with a lookup map

## Problem

`methodForCommand` in `src/infra/rpc-server.ts#L47-L100` is a 24-case switch mapping CLI commands to RPC methods. It scores complexity 25 while containing zero logic — it is data modeled as code. Every new protocol method extends the switch, and a missing case fails silently through the default instead of being caught by type-checking the full command set.

## Acceptance criteria

- [ ] Command → method mapping lives in a single `Record<string, string>` const table.
- [ ] A test asserts the table covers exactly the command set defined in the protocol registry (no orphan rows, no missing rows).
- [ ] `methodForCommand` is deleted or reduced to a one-line table read with explicit unknown-command error.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Smallest safe change from the 05-09-26 architecture review (`.tmp/reports/05-09-26/architecture-review.md` F2). Do this before any other rpc-server edit.
