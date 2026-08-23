---
id: TASK-0034
title: Define durable member inbox semantics
status: todo
depends_on: []
priority: high
tags: [crew, inbox, domain, durability, ubiquitous-language]
---

# Define durable member inbox semantics

## Problem
Crew leads need to leave work for peers without requiring peers to be online, but Bebop has no durable inbox or explicit ordering contract relative to live follow-ups and active turns.

## Context

Keep inbox as transport mechanism, not workflow engine. It stores an ordinary structured `MessagePayload` for configured member until Pi can accept it as non-interrupting follow-up. Message may mention task, plan, branch, or review in plain content, but Bebop does not parse or manage those concepts.

Lead leaving messages for offline peers is motivating workflow. Any joined member may enqueue initially; role names remain descriptive and grant no authority.

Proposed behavior:

```text
persist message -> notify recipient best-effort -> submit one item as Pi follow-up -> remove after durable session evidence
```

Rely on Pi follow-up FIFO rather than implementing scheduler: inbox item never redirects active turn, and follow-ups already accepted by Pi remain ahead of it. New messages follow normal arrival order; no priority queue.

## Acceptance criteria

- [ ] `Inbox` is defined as durable per-member message queue, distinct from transient follow-up and presence.
- [ ] Item schema stays minimal: version, stable ID, canonical target identity, structured payload, and deterministic order metadata.
- [ ] Acceptance means durably persisted, not delivered, started, completed, or answered.
- [ ] Recipient may be offline and item survives Bebop/Pi restart until handed into recipient session.
- [ ] Delivery uses normal Pi follow-up semantics; inbox never detects Git state, task readiness, review state, or active branch.
- [ ] Existing accepted follow-ups retain FIFO precedence without a separate priority scheduler.
- [ ] Stable item ID and session evidence define bounded crash deduplication; no unsupported exactly-once claim.
- [ ] Any joined member may enqueue; claimed role names grant no permissions.
- [ ] Minimal safety surface is defined: bounded list, cancel pending item, pause/resume automatic offering, and capacity limit.
- [ ] Domain schema/ordering tests are written before infrastructure work.

## Out of scope

- Task/assignment lifecycle, dependency tracking, work status, Git/worktree integration, review workflow, or CI.
- Cross-project/network inboxes, broadcast, folders, search, or rich mailbox UI.
