---
id: TASK-0158
title: Rewrite parseCrewManifest as schema-driven validation pipeline
status: doing
depends_on: []
priority: normal
tags: [refactor, manifest, validation]
---

# Rewrite parseCrewManifest as schema-driven validation pipeline

## Problem

parseCrewManifest in src/domain/crew-manifest.ts (lines 144-272) has
cyclomatic complexity 46 with 19 ifs, 17 logical operators, and inline
field-by-field checks. Manifest validation rules are buried in control flow
instead of declared as a schema.

## Desired outcome

The manifest contract is declared once as a TypeBox schema (the codebase's
existing schema tool); parsing becomes decode-then-normalize. Each
normalization step is a small named function. Error messages stay identical
where tests assert them.

## Approach

1. Characterization first: manifest tests pin accepted and rejected shapes;
   extend coverage for any branch currently untested (trust checks, path
   mapping, version gating).
2. Replace field-by-field ifs with a TypeBox `Value.Check` + errors pass.
3. Keep post-schema normalization (path resolution, name/role uniqueness) as
   small sequential steps, each CC < 15.
4. readTrustedCrewManifest (CC 34, crew-manifest-store.ts) is out of scope
   here except that its calls to parseCrewManifest keep working unchanged.

## Acceptance criteria

- [ ] parseCrewManifest CC < 15; no function in the file above 15.
- [ ] Manifest schema is a single declarative artifact, not scattered ifs.
- [ ] Existing accepted/rejected manifest tests pass unmodified.
- [ ] Domain purity preserved (typebox only).

## Non-goals

No manifest format change, no version bump, no store/IO changes.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

- 2026-09-04: Coordinator remains sole implementation owner under Mary's
  authorization for the TASK-0155 onward sequence.

