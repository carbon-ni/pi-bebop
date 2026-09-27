---
id: TASK-0248
title: Separate SDK discovery and authorized target routing
status: todo
depends_on: [TASK-0243]
priority: normal
tags: [sdk, discovery, routing, tdd]
---

# Separate discovery and routing

## Problem

Filesystem source discovery and authorized Crew/Member routing are different responsibilities. Mixing them with portable operations makes in-process reuse unsafe.

## Desired outcome

Explicit read-only discovery/selection boundaries serve CLI and external consumers, while in-process operations do not depend on them.

## Acceptance criteria

- [ ] Separate current source-list/select and Crew target-resolution capabilities without creating a second identity authority.
- [ ] CLI uses the shared boundaries where applicable; Pi in-process operations use current runtime identity directly.
- [ ] Preserve explicit source choice, aliases, trusted canonical paths, exact contact, ambiguity/conflict handling and bounded probes.
- [ ] No arbitrary live Member is borrowed as caller; cwd/manifest presence never grants permission.
- [ ] Tests cover duplicate names/worktrees, stale aliases/routes, offline/unknown sources, cancellation, bounded enumeration and no topology leaks in product output.
- [ ] Existing SDK selection API, packed consumers and exact-head gates pass.

## Non-goals

New admission, remote hosts, session resume or doctor integration. Follow `docs/SDK-REFACTOR.md`.
