---
id: TASK-0237
title: Use SDK for CLI Member status
status: todo
depends_on: [TASK-0236]
priority: high
tags: [sdk, cli, status, tdd]
---

# Use SDK for CLI Member status

## Problem

CLI Member status duplicates source transport and error handling already available through the SDK.

## Desired outcome

`bebop member status` is a thin parser/presenter around the SDK status operation.

## Acceptance criteria

- [ ] Remove command-local status RPC execution in favor of the public SDK boundary.
- [ ] Preserve explicit source selection, alias behavior and environment fallback without identity guessing.
- [ ] Preserve output formats, exit codes, offline-success semantics and actionable errors; no topology leaks.
- [ ] Preserve a bounded end-to-end deadline including any added selection work and SIGINT cancellation.
- [ ] Tests cover online/offline, missing source, rejection, malformed peer and cancellation through the command boundary.
- [ ] Packed CLI smoke and exact-head watcher/GitHub gates pass.

## Non-goals

Other commands, source discovery redesign, new authority or Pi migration. Follow `docs/SDK-REFACTOR.md`.
