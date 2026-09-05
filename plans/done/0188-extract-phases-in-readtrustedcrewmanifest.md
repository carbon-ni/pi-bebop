---
id: TASK-0188
title: Extract phases in readTrustedCrewManifest
status: done
depends_on: []
priority: high
tags: [techdebt, infra, complexity, trust]
---

# Extract phases in readTrustedCrewManifest

## Problem

`readTrustedCrewManifest` in `src/infra/crew-manifest-store.ts#L128-L250` scores cyclomatic complexity 29 across 123 LOC with 5 catch blocks and 10 logical operators. Resolve, read, validate, and trust-check phases are interleaved, so trust decisions — the security boundary — are buried inside parsing noise.

## Acceptance criteria

- [x] Function decomposes into named phases (`checkProjectTrust`, `resolveTrustedManifestPath`, `readAndParseManifest`, `resolveInstructionsRoot`, `resolveInstructionFile`, and `loadManifestInstructions`).
- [x] Trust check ordering is unchanged: trust is verified before manifest IO, per AGENTS.md contract.
- [x] Existing trust/compat-layout tests pass unmodified; phase failure paths remain covered by the manifest-store and integration suites.
- [x] Every extracted phase and `readTrustedCrewManifest` is ≤10 cyclomatic complexity.
- [x] Focused trust/layout tests, `npm run lint`, and watcher verification pass.

## Notes

Architecture review F2 (P1). Security-critical: behavior-preserving refactor only, TDD — pin current behavior with characterization tests before extraction.

Completed at `4b58f95`. Characterization tests passed before extraction; focused trust/layout suite passes 23/23 after extraction, lint and formatting pass, quality watcher gen 958 passes `make all`. The trust gate remains the first executable phase; all manifest and instruction IO stays after path validation.
