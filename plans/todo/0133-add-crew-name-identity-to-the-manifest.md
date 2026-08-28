---
id: TASK-0133
title: Add crew name as a display label in the manifest
status: doing
depends_on: []
priority: normal
tags: [crew, identity, manifest, ubiquitous-language]
---

## Problem

Receipts, the status footer, and intake messages identify the crew only by filesystem path or nothing at all; humans reading them get no memorable identity. The name is a LABEL, never an address: addressing stays manifest-path based (rotation and relocation are already handled by the manifest file itself).

## Scope

- Optional `name` in crew manifest v1, backward compatible; absent name keeps all current output.
- Surfaces: `/crew members`, `/crew status`, status footer pairing, intake receipts.
- `intake.contact` unchanged: routing policy behind the manifest.

## Acceptance

- Happy: named manifest surfaces label everywhere listed; unnamed manifest is byte-compatible with today.
- Unhappy: invalid name rejected at load with clear error; no surface falls back to guessing.
- Deterministic tests, both paths.

## Implemented surfaces (this change)

- Status footer: `formatIntrayFooter` optional crew name, named `joined <Crew> — <Member> (<Role>)`; unnamed/online/stopped byte-compatible (control-runtime + session-start integration).
- Joined Membership context: one optional `Crew name:` line next to `Crew: <manifestPath>`; unnamed byte-compatible (membership-context).
- External-intake receipt: `ExternalIntakeAck.crewName?` derived only from the loaded target manifest; CLI named form `Persisted for <contact> (<role>) of <Crew> — inbox item <id>`; unnamed unchanged (domain/application/cli adapter).
- Inbox handoff/display: recipient crew label derived from live trusted membership at handoff into typed `inbox.crewName` details; payload bytes and evidence id unchanged; renderer shows a bounded `Crew inbox: <name>` line only for valid typed details, fail-safe otherwise.

Status stays `doing` until Kelly's exact-hash QA.

## Accepted partial evidence

- `732decd` adds deterministic named/unnamed coverage for `/crew members` and `/crew status`.
- Kelly independently verified `732decd` from a clean detached worktree: `make all` passed all checks/audit and 1,381 tests. The recorded baseline caveat remains.
- This accepts the gate repair and the two implemented display surfaces only. It does not close TASK-0133: status footer, intake receipts/messages, joined context, and their named/unnamed tests remain open.
