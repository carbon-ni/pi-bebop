---
id: TASK-0224
title: Narrow session recovery dependencies
status: doing
depends_on: [TASK-0223]
priority: high
tags: [refactor, application, session, dependency-injection, tdd]
---

# Narrow session recovery dependencies

## Problem

`src/application/crew-session-resolution.ts` imports filesystem and concrete adapters, returns a complete Pi `SessionManager` through its dependency contract, and imports a domain decision through `pi/membership-context.ts`. Unit tests cast a small fake through `unknown` to `SessionManager`. Injection exists, but the application still owns framework and adapter details.

## Deliverable

A session-recovery operation using a narrow application-owned evidence contract, with concrete Pi/filesystem wiring outside the use case.

## Scope and approach

- Start with resolution and its callers; do not migrate all session workflows.
- Import `getLatestMembershipState` directly from domain.
- Replace the framework-shaped dependency with the evidence actually consumed: session identity, root, and membership evidence.
- Move default adapter composition to an existing runtime boundary or a cohesive adapter next to related infrastructure. Preserve convenient public entry points where callers require them.
- Test the concrete adapter separately against supported Pi session files.

## Acceptance criteria

- [ ] Application resolution no longer imports Pi integration modules or requires `SessionManager` in its dependency contract.
- [ ] Unit fakes satisfy the contract without framework casts; a fully supplied fake cannot accidentally invoke default IO.
- [ ] Existing exact-member resolution, inactive membership, drift, trust, malformed session, moved/ambiguous file, and already-open refusal behavior is preserved.
- [ ] Characterization tests precede changes; missing success/failure cases receive deterministic tests.
- [ ] Concrete adapter tests verify evidence mapping; focused tests and fresh watcher final gate pass.

## Non-goals

Changing resume authorization, automatically repairing records, launching Pi, a DI container, or a repository-wide port migration.
