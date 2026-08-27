---
id: TASK-0100
title: Add architecture guardrails to CI gate
status: todo
depends_on: []
priority: high
tags: []
---

# Add architecture guardrails to CI gate

## Problem
handleCommand (cyclomatic 102, 616 lines) and two >1000-line files landed with a fully green CI: make all checks format, types, tests, audit but nothing gates complexity, file size, or layering. The layering rules exist only as prose in AGENTS.md, so drift is invisible until a human audits it. Without a mechanical gate, the next god module lands the same way.

## Context
From the 13-04-26 arch review (`.tmp/reports/13-04-26/codebase-map.md`). Baseline: CI = `make all` = format-check + lint(typecheck) + build + test + security-check; hooks pre-commit = lint+test, pre-push = make all; no eslint.

Approved approach (outcome-first; implementation details to dev):
- One deterministic gate script under `scripts/` using the TypeScript compiler API (typescript is already a devDep — no new dependencies), exposing three checks:
  1. **Complexity ceiling** — per-function cyclomatic complexity (default fail > 15).
  2. **File-size ceiling** — lines per file (default fail > 500).
  3. **Layer direction + folder cycles** — import allow-list mirroring the verified module graph (domain→nothing; infra→domain; application/pi/tools→domain+infra; extension→everything; cli→application+cli+domain+infra, never pi/tools). Known cli↔cli/commands cycle is allowed-listed as the only legal cycle.
- **Ratchet file** `arch-baseline.json` listing today's offenders with measured values (e.g. control-runtime.ts handleCommand cc 102; protocol.ts 1293 lines). Rule: baseline entries only shrink or get removed; any NEW violation fails the build. Never re-baseline upward.
- Enforcement chain: `make arch-check` target, npm script, added to `make all` (pre-push + CI inherit); added to pre-commit (fast, deterministic).
- Task 0097/0098/0099 shrink the baseline; this gate keeps it shrunk.

## Acceptance criteria
- [ ] `make arch-check` runs locally in seconds, is deterministic (same tree = same result), and reports violations with file, function, and measured value.
- [ ] The ratchet file exists, contains only current offenders, and the gate fails on: (a) any new offender, (b) any baseline entry that grew.
- [ ] Layer check proves the documented graph: domain purity holds, no new folder cycles; cli↔cli/commands is the only cycle and only via an explicit allow-list entry.
- [ ] `make all` includes arch-check; CI green on the guard commit; pre-commit runs it.
- [ ] Sabotage test (TDD for the gate): a deliberately over-complex function and an illegal cross-layer import both fail the gate in a scratch branch/fixture.

## Non-goals
- No eslint adoption or new toolchain dependencies (typescript API only).
- No thresholds retroactively applied without the ratchet — existing offenders stay green until their refactor tasks land.
- No runtime/behavior changes to shipped code.

## Notes
Suggested order: land gate+ratchet first (green immediately), then 0097/0098 shrink the baseline as proof the ratchet works. Report: `.tmp/reports/13-04-26/codebase-map.md`.
