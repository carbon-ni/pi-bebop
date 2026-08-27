---
id: TASK-0102
title: Scaffold crew from external template sources
status: done
depends_on: []
priority: high
tags: [crew, cli, init, templates, git, provenance, determinism]
---

# Scaffold crew from external template sources

## Problem
A crew can only be created from pi-bebop's built-in scaffold, forcing people to manually copy and validate proven crew configurations. Users need a deterministic, provenance-visible way to initialize a crew from a local directory or Git repository.

## Context
Add cargo-generate-style template sources to `crew init` while preserving the built-in zero-argument scaffold and existing preflight/conflict contract. Product brief: `.tmp/reports/13-04-26/crew-init-from-template-brief.md`.

## Acceptance criteria
- [x] `crew init` without `--from` remains byte-identical, offline, and keeps existing exit codes.
- [x] Local directories and Git repositories can provide a strictly validated Crew template before any target write.
- [x] Git refs resolve deterministically and successful output exposes source provenance.
- [x] Exact reruns are unchanged; partial/differing/symlinked targets remain conflicts with zero overwrite, merge, or force behavior.
- [x] Stable usage and operational failures cover invalid sources, templates, refs, network/auth, and conflicts.
- [x] TOON, JSON, and text output preserve the defined provenance contract.
- [x] Kelly's executable acceptance and failure-path matrix passes on a clean worktree.

## Non-goals
- Template variables, registries/discovery, publisher signing, automatic upgrades, and private-repository authentication.

## Acceptance evidence
- Accepted reachable HEAD: `0339b93`.
- Focused matrix: 53/53.
- Full gate: `make all`, watcher generation 146 PASS.
- Clean worktree; rendered text provenance verified for created/unchanged local templates and production-path fixes.
- Report: `.tmp/reports/27-08-26/crew-init-from-acceptance-matrix.md`.

