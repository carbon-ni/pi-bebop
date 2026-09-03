---
id: TASK-0154
title: Decompose handleCommand into per-command handlers
status: todo
depends_on: []
priority: high
tags: [refactor, control-runtime, rpc, dispatch]
---

# Decompose handleCommand into per-command handlers

## Problem

handleCommand in src/pi/control-runtime.ts (lines 233-848) has cyclomatic
complexity 104, 616 LOC, nesting depth 7, 53 ifs and 9 catches in one function.
It routes every RPC command type inline, making any new command risky to add
and the file impossible to navigate.

## Desired outcome

`handleCommand` becomes a thin dispatcher: one small exported handler function
per RPC command, selected by a command-keyed map (not an if-chain). Routing,
dispatch, and per-command logic are visibly separate. No behavior change.

## Approach

1. Characterization safety net first: confirm existing
   `src/pi/control-runtime.test.ts` + real-wire integration tests pin current
   behavior (they exist; 97% coverage). Add missing cases only if a command is
   untested.
2. Extract one handler per command type (e.g. `handleSend`, `handleClear`,
   `handleStatus`, `handleSubscribe`, `handleAbort`), each returning the same
   response shape.
3. Replace the if-chain with a `Record<CommandType, Handler>` map; unknown
   command falls through to the existing error response path.
4. Keep `handleCommand` signature and error semantics identical (stale-context
   checks, error wrapping stay in one place).

## Acceptance criteria

- [ ] `handleCommand` body is <= ~20 lines; every extracted handler is CC < 15
      and the whole file passes `npm run verify:cli-complexity`-style limits.
- [ ] Behavior unchanged: full test suite green before/after (minus the known
      in-progress broadcast failures, which this task must not touch or fix).
- [ ] Handlers are individually exported for the follow-up split (TASK-0155).
- [ ] Coverage for touched lines does not drop below the current gate.

## Non-goals

No protocol changes, no new commands, no moving code out of the file (that is
TASK-0155).

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

