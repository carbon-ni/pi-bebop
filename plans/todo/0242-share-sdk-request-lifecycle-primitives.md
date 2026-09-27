---
id: TASK-0242
title: Share SDK Request start Response and outcome wait primitives
status: todo
depends_on: [TASK-0240]
priority: high
tags: [sdk, request, correlation, tdd]
---

# Share SDK Request lifecycle primitives

## Problem

Request/Response operations use several edge-specific paths, risking duplicate registries, wrong correlation and lost wake behavior during SDK adoption.

## Desired outcome

Typed start/respond/wait operations share the existing runtime registry. Pi tools and low-level CLI use them while keeping their distinct wait/presentation behavior.

## Acceptance criteria

- [ ] Introduce narrow Request operations backed by remote and in-process adapters; no second registry or callback server.
- [ ] Migrate Request send/respond/wait surfaces, preserving exact correlation, one accepted Response, and no duplicate send.
- [ ] Low-level operations may use opaque Request handles/IDs where their existing workflows require them; high-level Ask continues to hide IDs.
- [ ] Preserve pending-after-idle as nonterminal, max-wait ownership, allowed Guest routes, offline outcomes and payload limits.
- [ ] Pi inbound-message wake/yield stays at the Pi adapter; shared waits do not block delivery or discard messages.
- [ ] Tests cover concurrent requests, wrong/duplicate Response, authority revocation, late Response, route loss, cancellation and cleanup.
- [ ] Public types, packed low-level CLI and exact-head gates pass.

## Non-goals

Changing Ask timeout policy, persistence across runtime restart or automatic retry. Follow `docs/SDK-REFACTOR.md`.
