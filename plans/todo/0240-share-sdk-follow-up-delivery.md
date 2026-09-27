---
id: TASK-0240
title: Share SDK non-interrupting Follow-up delivery
status: todo
depends_on: [TASK-0237, TASK-0238]
priority: high
tags: [sdk, messaging, follow-up, tdd]
---

# Share SDK Follow-up delivery

## Problem

Follow-up transport and acknowledgement mapping differ across CLI, SDK and Pi tool adapters.

## Desired outcome

All three interfaces invoke one typed operation using remote or in-process adapters, with existing delivery policy owned by runtime.

## Acceptance criteria

- [ ] Migrate SDK, CLI Follow-up and Pi tool to the shared operation without duplicate policy or source self-RPC.
- [ ] Preserve exact payload bytes/order, limits, Member/approved Guest capability checks and runtime authority revalidation.
- [ ] Pi delivery remains `triggerTurn: true`, `deliverAs: followUp` during idle, streaming, tools and compaction; never steer/abort.
- [ ] Accepted/direct/queued output never claims read, action or completion.
- [ ] Pre-dispatch cancellation differs from possible-dispatch uncertainty; no automatic effect retry or fallback to Inbox.
- [ ] Contract/integration tests cover lifecycle races, offline, rejection, lost acknowledgement, cancellation and one dispatch.
- [ ] Packed interfaces and exact-head gates pass.

## Non-goals

Changing Follow-up semantics, completing TASK-0217 by assumption, durable delivery or urgent control. Follow `docs/SDK-REFACTOR.md`.
