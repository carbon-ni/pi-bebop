---
id: TASK-0240
title: Share SDK non-interrupting Follow-up delivery
status: done
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

- [x] Migrate SDK, CLI Follow-up and Pi tool to the shared operation without duplicate policy or source self-RPC.
- [x] Preserve exact payload bytes/order, limits, Member/approved Guest capability checks and runtime authority revalidation.
- [x] Pi delivery remains `triggerTurn: true`, `deliverAs: followUp` during idle, streaming, tools and compaction; never steer/abort.
- [x] Accepted/direct/queued output never claims read, action or completion.
- [x] Pre-dispatch cancellation differs from possible-dispatch uncertainty; no automatic effect retry or fallback to Inbox.
- [x] Contract/integration tests cover lifecycle races, offline, rejection, lost acknowledgement, cancellation and one dispatch.
- [x] Packed interfaces and exact-head gates pass.

## Non-goals

Changing Follow-up semantics, completing TASK-0217 by assumption, durable delivery or urgent control. Follow `docs/SDK-REFACTOR.md`.

## Evidence

- Implementation commit: `ae11a372f90f1fb0910c17e8e34ab3cc4643179e`.
- Draft PR: [#51](https://github.com/carbon-ni/pi-bebop/pull/51).
- Exact-head GitHub quality gate passed for `ae11a372f90f1fb0910c17e8e34ab3cc4643179e`: [run 36329452378](https://github.com/carbon-ni/pi-bebop/actions/runs/36329452378).
- Local `make all`, packed consumer verification, and production dependency security audit passed.
