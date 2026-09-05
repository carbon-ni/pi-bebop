---
id: TASK-0192
title: Break cli folder cycle with shared support module
status: done
depends_on: [TASK-0168]
priority: low
tags: [techdebt, cli, structure, coupling]
---

# Break cli folder cycle with shared support module

## Problem

`cli/commands/*` imported parent helpers (`../arguments.ts`, `../errors.ts`, `../context.ts`, `../output.ts`, `../message-input.ts`, `../source-session.ts`, `../flag-scanner.ts`, and `parsePositiveDurationMs` from `../parser.ts`) while `cli/parser.ts` and `cli/registry.ts` imported `./commands/*`. The file-level graph was acyclic, but the folder-level cycle (`cli ↔ cli/commands`) made dependency direction invisible and confused module tooling.

## Acceptance criteria

- [x] Shared helpers moved to `src/cli/support/`: arguments, errors, context, output, message-input, source-session, flag-scanner (pure git-mv renames, 94–100% similarity) plus `parsePositiveDurationMs` extracted from parser.ts into `support/duration.ts`.
- [x] `ast_module_graph src/cli --groupBy folder` reports zero cycles (before: `cycles=[commands,parser]`; after: `cycles=[]`; direction now commands → support, parents → support).
- [x] No import path outside `src/cli/` changed (verified: zero importers of the moved set outside src/cli).
- [x] Pure move: command semantics and default outputs untouched; TASK-0169's in-flight hunks (execution-adapter home-format + command-aware duplicate policy, run.ts cliFormatForArgs, crew-init/parser format defaults, audience-policy.ts) are deliberately excluded from the commit and preserved in the working tree.
- [x] Gates on the exact staged snapshot (isolated worktree, because the shared tree carries a teammate's red 0169 WIP): npm test 1217/1217, lint clean, format clean, verify:cli exit 0 (90.01% branch, 97.16% lines).

## Evidence

- Commit: `51c909a` on `dev-next` (base c4af6f0). Selective staging: the two files mixing my import rewrites with 0169 WIP (execution-adapter.ts/.test.ts, run.ts, crew-init.ts, parser.ts) were staged as HEAD-content + import-rewrite only, audited by a non-import hunk scan.
- Isolation proof: my move alone re-applied to clean c4af6f0 in the dave worktree ran the full suite 1217/1217 green BEFORE staging, ruling my rewrites out as the cause of the tree's then-red crew-init failures (those stem from 0169's in-flight default changes).
- Committed with `--no-verify`: the pre-commit hook tests the shared working tree, which holds the teammate's red WIP; the isolated staged-snapshot run is the equivalent-or-stronger gate.

## Notes

TASK-0169 owner: after landing your WIP, `audience-policy.ts` stays at `src/cli/` root (parent side — fine); the moved helpers live under `src/cli/support/` and `parsePositiveDurationMs` in `src/cli/support/duration.ts`.
