---
id: TASK-0192
title: Break cli folder cycle with shared support module
status: todo
depends_on: []
priority: low
tags: [techdebt, cli, structure, coupling]
---

# Break cli folder cycle with shared support module

## Problem

`cli/commands/*` import parent helpers (`../arguments.ts`, `../errors.ts`, `../context.ts`, `../output.ts`) while `cli/parser.ts` and `cli/registry.ts` import `./commands/*`. The file-level graph is acyclic, but the folder-level cycle (`cli ↔ cli/commands`) makes dependency direction invisible and confuses module tooling and newcomers.

## Acceptance criteria

- [ ] Shared helpers moved to `src/cli/support/` (or commands restructured so parents never import children's siblings).
- [ ] `ast_module_graph src --groupBy folder` reports zero cycles.
- [ ] No import path outside `src/cli/` changes.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Architecture review F6. Pure move — no behavior change. Coordinate with the commander migration tasks (TASK-0166..0168) if they touch the same files: land this between migration steps, not during.
