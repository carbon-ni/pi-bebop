---
id: TASK-0236
title: Add SDK status operation with remote and in-process adapters
status: done
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

- [x] Characterization tests capture current SDK status results/errors before refactoring in `src/sdk/index.test.ts`; the pre-change focused run passed 28/28 SDK tests.
- [x] Introduce a narrow typed status dependency (`MemberStatusOperation` and `InProcessMemberStatusOperationDependencies`); no generic raw RPC API, full-client stubs or second state owner.
- [x] Remote `BebopSource.getMemberStatus` remains compatible through the extracted remote adapter. In-process use receives a live surface and requires no source socket or `PI_SESSION_ID`.
- [x] Reuse `createMemberStatusFlow` for policy; membership, trust, role/name resolution, self-query and identity checks remain owned by the existing application flow.
- [x] Runtime authority is checked at operation time; status remains joined-Member-only and is not granted by Guest request permission.
- [x] Deterministic contract cases in `src/sdk/member-status-operation.test.ts` cover online/offline, invalid input, untrusted/unjoined, self target, malformed/foreign identity, deadline and cancellation; existing remote tests cover ambiguous target mapping.
- [x] Remote tests exercise real Unix sockets; local tests prove self-query rejects before probe/request, so the in-process path performs no source self-RPC. Remote target communication remains allowed.
- [x] Existing SDK imports and packed declarations pass (`npm run verify:package`, packed SDK contract, and a temporary consumer importing the in-process factory/types); the SDK bundle imports no Commander/Pi runtime and performs no discovery on operation import.
- [x] Exact-head isolated task-worktree watcher and GitHub gates passed; the release handoff records the final cwd, socket, generation, terminal results, and unchanged-fingerprint freshness.

## Verification record

- PR: #46 (draft); final board-closure SHA and exact-head watcher evidence are recorded in the release handoff
- Focused SDK tests: 36/36 passed
- SDK coverage: `src/sdk/index.ts` 97.53% lines / 82.93% branches; new contract test 99.42% lines / 100% branches
- Exact-head QA: Kelly PASS on implementation SHA `9b4a7e8`; remote sockets, no-self-RPC, live joined/trusted checks, cancellation/deadline, declarations, and packed consumer verified
- No known blockers; CLI/Pi migration remains TASK-0237/0238

## Non-goals

CLI/tool migration (TASK-0237/0238), new status permissions, changing wire protocol, extracting all SDK methods, or adding another runtime/service registry. Follow `docs/SDK-REFACTOR.md`.
