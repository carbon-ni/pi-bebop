---
id: TASK-0037
title: Hand inbox messages to Pi follow-up delivery
status: doing
depends_on: [TASK-0035]
priority: high
tags: [crew, inbox, application, lifecycle, recovery]
---

# Hand inbox messages to Pi follow-up delivery

## Problem
Persisted inbox work is useful only when a member can claim and process it after active work and live follow-ups without duplicate, lost, or out-of-order execution across lifecycle transitions.

## Context

Add small bridge from durable queue to existing Pi follow-up delivery. Do not build worker scheduler or track task completion. Submit at most one inbox item at a time, tagged with stable item ID; Pi owns turn ordering.

Triggers are membership restore/start, best-effort inbox hint, and `turn_end`. Each trigger may attempt to offer oldest item as normal follow-up. Existing Pi follow-ups already queued remain ahead through FIFO. Item is removed only after durable recipient session evidence contains its ID; startup reconciles storage against that evidence to close crash window.

## Acceptance criteria

- [ ] Join/restore and valid hint check inbox only after current member ownership is established.
- [ ] Oldest item is submitted as normal follow-up, never steer/redirect.
- [ ] At most one inbox item is outstanding; repeated hints/turn events are idempotent.
- [ ] Existing accepted Pi follow-ups retain FIFO position; no custom priority/idle scheduler is implemented.
- [ ] Stable item ID is persisted in typed session message details and used for restart reconciliation before file removal.
- [ ] Only current endpoint owner consumes its queue; role switch, leave, stop, and shutdown invalidate stale attempts.
- [ ] `/crew inbox` shows bounded pending metadata without exposing message contents by default.
- [ ] `/crew inbox cancel <id>` removes only a pending item and is idempotent.
- [ ] `/crew inbox pause|resume` controls automatic offering without deleting pending items.
- [ ] Malformed item is bounded/quarantined so healthy later items are not permanently blocked.
- [ ] Lifecycle, ordering, duplicate-trigger, crash-window, and cleanup tests pass.

## Out of scope

- Determining whether software task completed, work status, retries based on assistant result, preemption, Git, or consuming another member inbox.
