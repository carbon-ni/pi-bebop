---
id: TASK-0193
title: Stabilize CLI branch coverage gate out of its flake band
status: doing
depends_on: []
priority: high
tags: [techdebt, cli, coverage, determinism, gates]
---

# Stabilize CLI branch coverage gate out of its flake band

## Problem

`npm run verify:cli` enforces `--test-coverage-branches=90`, but actual branch coverage oscillates in a **±0.15% band around the threshold on identical code** (observed: 89.87 / 89.92 / 89.97 / 90.02 across consecutive runs, gen=951 failed while its own report printed 90.02). The gate is nondeterministic: it randomly fails green code, blocking every crew member's final watcher gate (AGENTS.md determinism rule violated by our own CI gate).

## Evidence (05-09-26)

- 3 consecutive `verify:cli` runs on identical HEAD: exits 1,1,1 with 89.87%, 89.92%, 89.97% branch.
- Per-file coverage tables are byte-identical across runs while totals move ±0.15% — movers are a few high-count files whose rounded percentages hide 1–3 flipping branches.
- Structural (deterministic) gaps: `version.ts` 75% branch (build-time `__PI_BEBOP_*__` define ternaries — unreachable under tsx; note: a query-string fresh-import test makes it WORSE by double-counting module instances, 75→57), `guest.ts` 72% (lines 140–169, 219–310), `registry.ts` (135–298 partial), `durable-message.ts` 178–226.
- Suspected flaky sources: async timeout/retry branches in `rpc-client.ts` (41–43, 145, 163, 289–290, 325–327, 350–360).

## Acceptance criteria

- [ ] Identify the exact flipping branches: run `verify:cli` twice with JSON coverage export (`--test-coverage-exclude`-free diff) and diff per-branch hits.
- [ ] Stabilize flaky async branches with deterministic barriers/fake clocks (no sleeps), OR lift deterministic gaps by ≥0.3% with real tests (guest.ts, registry.ts, durable-message.ts ranges above).
- [ ] Do NOT game the threshold (no lowering 90, no `--test-coverage-exclude`) without an explicit product decision recorded here.
- [ ] 10 consecutive `verify:cli` runs all green with min observed branch % ≥ 90.10 (margin above the band).
- [ ] Full watcher chain green twice in a row.

## Notes

Do not use query-string module re-imports to cover build-time defines (double-counts instances and lowers net coverage — verified experimentally).
