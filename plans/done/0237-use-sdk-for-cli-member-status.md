---
id: TASK-0237
title: Use SDK for CLI Member status
status: done
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

- [x] Remove command-local status RPC execution in favor of the public SDK boundary.
- [x] Preserve explicit source selection, alias behavior and environment fallback without identity guessing.
- [x] Preserve output formats, exit codes, offline-success semantics and actionable errors; no topology leaks.
- [x] Preserve a bounded end-to-end deadline including any added selection work and SIGINT cancellation.
- [x] Tests cover online/offline, missing source, rejection, malformed peer and cancellation through the command boundary.
- [x] Packed CLI smoke and exact-head watcher/GitHub gates pass; exact final revision evidence is in the PR handoff.

## Verification

- CLI status now selects a trusted joined source and queries status through `createBebopClient`; source selection and operation share one 5-second deadline and SIGINT signal.
- Focused CLI status, integration, operational-format, and packaged end-to-end tests pass.
- TypeScript typecheck and Prettier checks pass.
- Exact final SHA, isolated watcher socket/generation, freshness, and GitHub gate results are recorded in the PR handoff.

## Non-goals

Other commands, source discovery redesign, new authority or Pi migration. Follow `docs/SDK-REFACTOR.md`.
