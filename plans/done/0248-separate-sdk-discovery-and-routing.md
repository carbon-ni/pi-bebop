---
id: TASK-0248
title: Separate SDK discovery and authorized target routing
status: done
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

- [x] Separate current source-list/select and Crew target-resolution capabilities without creating a second identity authority.
- [x] CLI uses the shared boundaries where applicable; Pi in-process operations use current runtime identity directly.
- [x] Preserve explicit source choice, aliases, trusted canonical paths, exact contact, ambiguity/conflict handling and bounded probes.
- [x] No arbitrary live Member is borrowed as caller; cwd/manifest presence never grants permission.
- [x] Tests cover duplicate names/worktrees, stale aliases/routes, offline/unknown sources, cancellation, bounded enumeration and no topology leaks in product output.
- [x] Existing SDK selection API, packed consumers and exact-head gates pass.

## Verification

- Extracted bounded source discovery/selection into `src/sdk/source-discovery.ts`; remote operations remain source-bound and in-process operations remain runtime-injected.
- Focused SDK, target-resolution, and CLI status tests: 91 passed.
- Format, typecheck, presence typecheck, and SDK build passed.

## Non-goals

New admission, remote hosts, session resume or doctor integration. Follow `docs/SDK-REFACTOR.md`.
