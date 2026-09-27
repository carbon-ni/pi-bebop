---
id: TASK-0241
title: Share SDK durable Inbox operation
status: todo
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

- [ ] Migrate the existing SDK, CLI and Pi Inbox surfaces through remote/in-process adapters.
- [ ] Persistence remains possible for offline configured recipients; accepted persistence never means delivered/read.
- [ ] Preserve authorization, payload limits, item identity, delivery-hint semantics and existing storage/lifecycle behavior.
- [ ] No client-owned Inbox store, duplicate enqueue or automatic retry after uncertain acknowledgement.
- [ ] Tests cover offline persistence, rejected/full storage, malformed acknowledgement, cancellation/uncertainty and one enqueue.
- [ ] Packed consumers and exact-head gates pass.

## Non-goals

Filesystem Intake refactor, storage format migration or new Guest capabilities. Follow `docs/SDK-REFACTOR.md`.
