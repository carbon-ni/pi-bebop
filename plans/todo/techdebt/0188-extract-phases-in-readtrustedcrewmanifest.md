---
id: TASK-0188
title: Extract phases in readTrustedCrewManifest
status: todo
depends_on: []
priority: high
tags: [techdebt, infra, complexity, trust]
---

# Extract phases in readTrustedCrewManifest

## Problem

`readTrustedCrewManifest` in `src/infra/crew-manifest-store.ts#L128-L250` scores cyclomatic complexity 29 across 123 LOC with 5 catch blocks and 10 logical operators. Resolve, read, validate, and trust-check phases are interleaved, so trust decisions — the security boundary — are buried inside parsing noise.

## Acceptance criteria

- [ ] Function decomposes into named phases (e.g. `resolveManifestPath`, `readManifestFile`, `validateManifest`, `checkProjectTrust`), each testable in isolation.
- [ ] Trust check ordering is unchanged: trust is verified before manifest IO, per AGENTS.md contract.
- [ ] Existing trust/compat-layout tests pass unmodified; new unit tests cover each extracted phase including failure paths.
- [ ] Cyclomatic complexity of every resulting function ≤ 10.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Architecture review F2 (P1). Security-critical: behavior-preserving refactor only, TDD — pin current behavior with characterization tests before extraction.
