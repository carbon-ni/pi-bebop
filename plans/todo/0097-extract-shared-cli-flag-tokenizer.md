---
id: TASK-0097
title: Extract shared CLI flag tokenizer
status: doing
depends_on: []
priority: high
tags: []
---

# Extract shared CLI flag tokenizer

## Problem
Seven CLI command parsers (parser.ts + member-message, durable-message, member-status, member-idle-wait, session-list, crew-roles) each hand-roll the same flag loop: equals-split, seen-set dedup, --help duplicate check, -- escape. A fix to one loop (e.g. -- semantics) must be re-applied seven times; every new command re-implements the wheel.

## Context
From the 13-04-26 arch review (`.tmp/reports/13-04-26/codebase-map.md`, finding F2). `parseMemberMessageCommand` (cc 40) and `parseDurableMessageCommand` (cc 31) are near-twins; all seven share the identical token loop. Approach: new `cli/flags.ts` with `parseFlagTokens(args, spec)` owning mechanics (equals-split, dedup, `--help`, `--` escape); commands keep intent-specific validation (semantics, wait/mode rules). No public CLI behavior change.

## Acceptance criteria
- [ ] One flag-tokenizer module in `cli/` owns equals-split, seen-set dedup, `--help` duplicate errors, and `--` escape handling; the seven parsers consume it.
- [ ] All existing usage-error tests pass unchanged (error messages byte-identical).
- [ ] `npm test` and `npm run lint` green.
- [ ] Complexity of each migrated parser fn drops below 15.

## Non-goals
- No CLI surface changes (flags, help text, output formats stay identical).
- Not restructuring cli vs cli/commands (that's a separate cosmetic split).

## Notes
TDD: characterization tests on current error behaviors first (if gaps), then extract.
