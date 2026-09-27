---
id: TASK-0239
title: Share SDK last assistant message snapshots
status: done
depends_on: [TASK-0237, TASK-0238]
priority: normal
tags: [sdk, cli, snapshots, tdd]
---

# Share SDK last-message snapshots

## Problem

Last-message inspection has separate remote/client adaptation and should use the proven read-only SDK boundary.

## Desired outcome

Remote and in-process consumers share the snapshot operation; existing CLI inspection uses it.

## Acceptance criteria

- [x] Reuse the existing application snapshot flow through typed SDK adapters; preserve the existing SDK method.
- [x] Migrate the existing CLI snapshot command without adding a new Pi tool solely for parity.
- [x] Preserve empty history, UTF-8 content, timestamps, size limits, identity and privacy checks.
- [x] Tests cover empty/available/oversized history, offline, malformed identity, denied authority and cancellation on both paths.
- [x] Snapshot retrieval never starts a turn or treats text as verified progress/completion.
- [x] Packed consumers and exact-head gates pass.

## Non-goals

History browsing, session resume, new permissions or interpreting message content. Follow `docs/SDK-REFACTOR.md`.
