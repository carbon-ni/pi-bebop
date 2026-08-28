# TASK-0088 slice 1 — inventory and direct-render guard

## Change
- Added frozen v1 inventory constants and runtime snapshot tests for 12 CLI leaves, 12 tools, `/crew` actions, and subaction vocabulary.
- Added `scripts/error-boundary-check.mjs` with ratcheted baseline and reviewed-exemption table shape. It scans frozen adapter scopes and rejects new direct error renders.
- Wired `verify:error-boundary` into Makefile and pre-commit.

## Evidence
- `npm run verify:error-boundary` — PASS (19 baseline entries)
- `npx tsx --test src/domain/actionable-error-inventory.test.ts` — 5/5 PASS
- `npm run typecheck` — PASS

## Limitation
The guard uses deterministic line scanning grouped by file/render kind; migration slices will reduce baseline counts. Shared presenter call lines are exempted by presenter markers.
