---
id: TASK-0226
title: Narrow request-handler runtime dependencies
status: done
depends_on: [TASK-0225]
priority: normal
tags: [refactor, pi, runtime, dependency-injection, aesthetics, tdd]
---

# Narrow request-handler runtime dependencies

## Problem

`CommandHandlerContext` gives every handler the broad mutable `SocketState`, which mixes connection state, subscriptions, membership, transports, and optional services. Request handlers must infer availability from unrelated optional fields and can access capabilities they do not need.

## Deliverable

A narrow dependency boundary for the Member Request handler family, demonstrating how stable services and current runtime state can be separated without rewriting all handlers.

## Scope and approach

- Build on the semantic flow operations from TASK-0225.
- Define required request-handler capabilities near their consumer and supply them at runtime composition/dispatch.
- Keep lifecycle-sensitive membership and trust reads live; do not freeze context accidentally during construction.
- Replace the guest-start async IIFE and non-null assertions with explicit validated branches where this boundary is changed.

## Acceptance criteria

- [x] Request handlers no longer receive the entire mutable `SocketState`; capability types expose only needed operations.
- [x] Test fixtures can construct the handler without unrelated status, inbox, alias, or server services.
- [x] Joined/unjoined, trusted/untrusted, approved/unapproved Guest, unavailable flow, and lifecycle-transition paths retain their outcomes.
- [x] No new initialization-order requirement, stale membership snapshot, or altered message acceptance order is introduced.
- [x] Focused tests and fresh watcher final gate pass; changed branch coverage is recorded.

## Non-goals

Replacing all runtime state, migrating every command handler, a dependency container, or eliminating optional values that represent real runtime absence.
