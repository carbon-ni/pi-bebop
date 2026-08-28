---
id: TASK-0127
title: Name joined Pi sessions after their Current Member
status: done
depends_on: []
priority: high
tags: [crew, membership, session-name, identity, alias, pi-api, lifecycle, tdd]
---

# Name joined Pi sessions after their Current Member

## Problem
A joined session can show generic or task-oriented naming in Pi's session selector, so operators cannot reliably identify the Current Member there. Bebop should supply a safe Member-name default without overwriting deliberate user naming or creating colliding global routing aliases.

## Product contract

Pi 0.84.3 exposes `pi.setSessionName(name)`, `pi.getSessionName()`, and `session_info_changed`; an empty name clears the display name. The display name appears in the footer/session selector and is metadata only.

On successful join/restore/rejoin, Bebop sets the exact trusted Current Member name as the **default** Pi session display name only when the session has no existing name. Bebop never overwrites a name explicitly supplied through `--name`, `/name`, RPC, or another extension.

When Bebop owns the default:

- a Current Member switch updates it to the new exact Member name;
- leave, removal, inactive Membership, stop, failed restore, and shutdown clear it only if the current name still equals Bebop's owned value;
- a user/manual change immediately relinquishes Bebop ownership and remains untouched;
- reload/resume/fork reconstruct ownership from bounded session metadata rather than guessing from equal text.

The auto Member name is display metadata, never Membership/identity proof or Role authority. It must not become the unscoped global session-name alias: two projects may both have `Mary`, and the existing alias publisher would otherwise make them replace each other's alias. Auto-owned names keep only the existing collision-safe project/branch alias. A later manual session name retains existing user alias behavior.

## Implementation plan

1. Characterize Pi name set/get/clear and `session_info_changed` ordering with a deterministic fake Pi host.
2. Add a pure ownership reducer for inactive, auto-owned, and user-owned states plus a bounded custom-entry snapshot.
3. Wire successful Membership activation/switch and every release/failure lifecycle without starting a turn.
4. Teach alias sync to distinguish auto-owned Member display name from manual session alias.
5. Add restart/reload/resume/fork and cross-project collision tests before implementation.

## Acceptance criteria

- [x] Unnamed session gets exact Current Member `name` after successful join, restore, or rejoin; Role, description, socket filename, alias, and CLI input are never used.
- [x] Existing startup/manual/RPC/other-extension session name is byte-preserved and never replaced merely because Membership activates.
- [x] While auto-owned, same-session Member switch updates the exact name; Role-only change with same Member name is idempotent.
- [x] Manual `/name`/RPC/extension change after auto-naming relinquishes ownership immediately; later refresh, alias tick, Presence, or prompt construction cannot overwrite it.
- [x] Leave, removal, inactive state, stop, failed restore, and shutdown clear only a still-matching auto-owned name using Pi's empty-name contract; a manual name is never cleared.
- [x] Reload/resume/fork restores auto ownership only from a valid bounded typed session entry matching the current session-name and Membership snapshot; text equality alone never grants ownership.
- [x] Auto-owned name is excluded from the unscoped session-name alias. Collision-safe project/branch alias remains; two projects with the same Member name never steal/thrash one alias.
- [x] A later manual name keeps existing safe alias behavior; unsafe manual alias handling remains unchanged.
- [x] Naming and clearing append only bounded metadata, trigger no provider/model turn/message, perform no network IO, and never claim authentication, Presence, Activity, availability, or authority.
- [x] Invalid/oversized/control-bearing Member names remain rejected by manifest loading before naming; stale Pi context/name failures are bounded and cannot corrupt Membership or aliases.
- [x] Deterministic tests cover unnamed/named join, restore, rejoin, switch, manual override/clear, leave/stop/shutdown, failed restore, reload/resume/fork, duplicate project Member names, event reentrancy, and no-turn behavior.
- [x] Existing status-line, session alias, Membership, startup, and lifecycle tests remain green; focused/full watcher gates pass.

## Evidence

- Implementation: `088f03a`; bounded API/host hardening: `77b5897`; manifest-boundary validation and direct snapshot defense: `d212183`; lifecycle/alias integration coverage: `8d73af9`.
- Verification: Kelly detached exact-commit QA PASS at `8d73af9`; focused matrix `140/140`; fresh watcher generation 195 `@agent-final`/`make all` PASS; full suite `1,452/1,452`; worktree clean.
- QA report: `.tmp/reports/13-04-26/task-0127-8d73af9-final-qa.md`.

## Non-goals

Renaming unjoined sessions, forcing names over explicit user choice, making session name an identity credential, changing Member names, global alias discovery redesign, or naming standalone CLI processes.

## Evidence

- Pi documentation: `docs/sessions.md`, `docs/extensions.md` (`pi.setSessionName`, `pi.getSessionName`, `session_info_changed`).
- Pi example: `examples/extensions/session-name.ts`.
- Existing alias risk: `src/pi/control-runtime.ts#getSessionAlias` plus `src/infra/control-store.ts#createAliasSymlink` publishes an unscoped session-name alias and replaces its prior symlink.
