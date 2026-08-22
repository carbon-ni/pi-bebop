---
id: TASK-0020
title: Introduce Prettier formatting
status: done
depends_on: []
priority: normal
tags: [tooling, formatting, prettier]
---

# Introduce Prettier formatting

## Problem
The watcher now references a format recovery command, but the repository has no formatter dependency or format scripts, so formatting failures cannot be checked or repaired consistently.

## Context
Add Prettier as a pinned development dependency and define deterministic check/write scripts for the supported TypeScript and configuration files. Wire the check into the watcher/quality gate and keep the existing recovery command aligned with the write script.

## Acceptance criteria
- [ ] Prettier is pinned in `devDependencies` and has a repository configuration covering the intended source/config files.
- [ ] `npm run format:check` fails when tracked files are not formatted, and `npm run format:write` fixes those files.
- [ ] `.watch.yaml` runs the format check and offers `npm run format:write` as its recovery command without introducing a recovery loop; typecheck remains a separate non-recoverable check.
- [ ] Existing typecheck, tests, security checks, and formatting checks pass.
- [ ] Formatting scope and commands are documented for contributors.

## Notes
- TypeScript type errors are not safely auto-fixable by `tsc`; they require code changes, so no recovery command is attached to the typecheck job.
- Consider whether package metadata/config files should be included in the initial Prettier scope.
- Format before enabling the check to avoid unrelated formatting noise in later changes.

