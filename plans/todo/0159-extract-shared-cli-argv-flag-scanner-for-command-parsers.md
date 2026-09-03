---
id: TASK-0159
title: Extract shared CLI argv flag scanner for command parsers
status: todo
depends_on: []
priority: normal
tags: [refactor, cli, parsers]
---

# Extract shared CLI argv flag scanner for command parsers

## Problem

Five CLI command parsers duplicate the same loop shape:
parseMemberMessageCommand (CC 40), parseDurableMessageCommand (CC 31),
parseSendCommand (CC 31), parseMemberStatusCommand (CC 21),
parseMemberIdleWaitCommand (CC 20). Each re-implements argv iteration,
ternary flag matching, and flag validation; a flag bug must be fixed five
times.

## Desired outcome

One shared flag-scanning primitive in `src/cli/` that consumes argv against a
per-command flag table (name, arity, validator). Command parsers become:
scan argv via the shared scanner, then map the result to their command
struct. Help text and error messages for flags come from the table.

## Approach

1. Characterization first: `src/cli/main.test.ts` (1381 lines) plus
   cli-contract tests already pin flag behavior across commands; add cases
   for any untested flag edge (repeated flags, `--flag=value` vs two-token
   form, unknown flag errors).
2. Build the scanner TDD-first, then migrate parsers one command per commit,
   smallest first (member-status, member-idle-wait, durable-message, send,
   member-message).
3. Each migrated parser must show a CC drop (target < 15 each) and identical
   externally observable behavior.
4. Keep `npm run verify:cli-complexity` green throughout; it is the gate.

## Acceptance criteria

- [ ] All five parsers CC < 15 (from 40/31/31/21/20).
- [ ] Exactly one argv-iteration implementation in `src/cli/`.
- [ ] Existing CLI tests pass unmodified; contract tests confirm
      tool/CLI parity.
- [ ] Flag error messages identical where tests assert them.

## Non-goals

No new flags, no flag renames, no change to the command registry or wire
protocol.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

