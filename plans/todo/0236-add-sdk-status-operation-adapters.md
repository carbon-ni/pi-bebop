---
id: TASK-0236
title: Add SDK status operation with remote and in-process adapters
status: todo
depends_on: [TASK-0235]
priority: high
tags: [sdk, adapters, status, tdd]
---

# Add SDK status operation adapters

## Problem

SDK status is coupled to socket calls, while the reusable application status flow already exists. Pi cannot use the public operation without self-RPC.

## Desired outcome

One typed status operation can run against a selected remote source or trusted in-process runtime dependencies.

## Acceptance criteria

- [ ] Characterization tests capture current SDK status results/errors before refactoring.
- [ ] Introduce a narrow typed status dependency; no generic raw RPC API, full-client stubs or second state owner.
- [ ] Remote `BebopSource.getMemberStatus` remains compatible. In-process use requires no source socket or `PI_SESSION_ID`.
- [ ] Reuse `createMemberStatusFlow` for policy; do not duplicate membership, trust, role/name resolution, self-query or identity checks.
- [ ] Runtime authority is checked at operation time; status remains joined-Member-only, not granted by Guest request permission.
- [ ] Deterministic shared contract cases cover online/offline, invalid input, untrusted/unjoined, ambiguous/self target, malformed/foreign identity, deadline and cancellation.
- [ ] Remote tests exercise real sockets; local tests prove no source self-RPC. Remote target communication remains allowed.
- [ ] Existing SDK imports and packed declarations pass; in-process imports do not load Commander/Pi or require filesystem discovery.
- [ ] Exact-head local watcher and GitHub gates pass with recorded evidence.

## Non-goals

CLI/tool migration (TASK-0237/0238), new status permissions, changing wire protocol, extracting all SDK methods, or adding another runtime/service registry. Follow `docs/SDK-REFACTOR.md`.
