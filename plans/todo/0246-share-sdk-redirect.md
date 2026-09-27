---
id: TASK-0246
title: Share SDK explicit Redirect capability
status: todo
depends_on: [TASK-0240]
priority: normal
tags: [sdk, redirect, tdd]
---

# Share Redirect

## Problem

Urgent steering must not be hidden behind Follow-up options or duplicated across interfaces.

## Desired outcome

A distinct typed Redirect operation is used by CLI and Pi through SDK adapters.

## Acceptance criteria

- [ ] Reuse runtime Redirect policy; preserve authority, payload rules and `deliverAs: steer`.
- [ ] No hard abort, rollback or Inbox fallback; accepted never means acted upon.
- [ ] Tests distinguish Follow-up, Redirect and Interrupt and cover idle/busy, rejection, offline, cancellation and uncertain dispatch.
- [ ] No self-RPC, automatic effect retry or new permissions.
- [ ] Packed consumers and exact-head gates pass.

## Non-goals

Interrupt migration or priority scheduling. Follow `docs/SDK-REFACTOR.md`.
