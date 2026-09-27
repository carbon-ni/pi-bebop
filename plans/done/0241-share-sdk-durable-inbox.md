---
id: TASK-0241
title: Share SDK durable Inbox operation
status: done
depends_on: [TASK-0240]
priority: normal
tags: [sdk, inbox, persistence, tdd]
---

# Share SDK durable Inbox

## Problem

Inbox acceptance/storage adaptation should not diverge between CLI, SDK and Pi tools.

## Desired outcome

One typed operation delegates durable enqueue to the existing runtime/storage owner.

## Acceptance criteria

- [x] Migrate the existing SDK, CLI and Pi Inbox surfaces through remote/in-process adapters.
- [x] Persistence remains possible for offline configured recipients; accepted persistence never means delivered/read.
- [x] Preserve authorization, payload limits, item identity, delivery-hint semantics and existing storage/lifecycle behavior.
- [x] No client-owned Inbox store, duplicate enqueue or automatic retry after uncertain acknowledgement.
- [x] Tests cover offline persistence, rejected/full storage, malformed acknowledgement, cancellation/uncertainty and one enqueue.
- [x] Packed consumers and exact-head gates pass.

## Verification evidence

- `make all`: formatting, lint/typechecks, build, all 1,497 tests, and production dependency audit passed.
- `npm run verify:cli`: CLI coverage, complexity, and isolated packed-consumer/Pi-loader verification passed.
- Focused integration verifies remote Inbox enqueue and Broadcast remain distinct; in-process checks cover live authority, offline persistence, cancellation boundaries, storage-full mapping, stable item identity, and no duplicate enqueue after uncertainty.
- Final verification was run for the submitted PR head; see the TASK-0241 review report for its SHA.

## Non-goals

Filesystem Intake refactor, storage format migration or new Guest capabilities. Follow `docs/SDK-REFACTOR.md`.
