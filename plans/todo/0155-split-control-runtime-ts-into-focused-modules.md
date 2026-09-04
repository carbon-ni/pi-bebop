---
id: TASK-0155
title: Split control-runtime.ts into focused modules
status: doing
depends_on: [TASK-0154]
priority: high
tags: [refactor, control-runtime]
---

# Split control-runtime.ts into focused modules

## Problem

src/pi/control-runtime.ts is 1057 lines holding socket lifecycle, command
routing, alias sync, membership tool activation, and status derivation in one
file. The project's own 500-line guardrail flags it, and every concern shares
imports with every other.

## Desired outcome

`src/pi/control-runtime/` (or sibling modules) with one responsibility per
file: base server lifecycle, command dispatch, alias sync, membership tool
activation/deactivation, status derivation. Each well under 500 lines;
`extension.ts` keeps composing them.

## Approach

1. Depends on TASK-0154: per-command handlers already extracted and exported,
   so the dispatch module moves as a unit.
2. Move membership tool activation and status derivation first (least shared
   state), then alias sync, then command dispatch, leaving lifecycle +
   SocketState creation in `control-runtime.ts` as the composition entry.
3. Preserve all current exports (or re-export from the original path) so
   importers outside the file do not churn.
4. Update AGENTS.md architecture notes if module boundaries change materially.

## Acceptance criteria

- [ ] No production file in the `src/pi/control-runtime/` split or its composition root exceeds 500 lines.
- [ ] Existing public exports of `control-runtime.ts` still resolve from the
      same import path (or all importers updated in the same commit).
- [ ] Full test suite green; integration tests untouched.
- [ ] No domain-layer imports introduced; layering rules respected.

## Non-goals

No behavior change, no protocol work, no renaming of exported symbols.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

- 2026-09-04: Mary authorized the coordinator (session 01a0675d) as sole
  implementation owner. Dave's unavailable runtime will not receive work.
- Takeover snapshot at HEAD `a284eac17e5489194789bad11a76bb32587db812` with clean
  worktree is recorded in `.tmp/reports/04-09-26/task-0155-takeover-head.txt` and
  `.tmp/reports/04-09-26/task-0155-takeover-status.txt` before edits.
- 2026-09-04: Independent review found pre-existing oversized files outside this
  refactor (`src/pi/startup-send.ts` and test/integration files). The line-count
  criterion is scoped to the new control-runtime production split and root;
  those unrelated files remain unchanged.

