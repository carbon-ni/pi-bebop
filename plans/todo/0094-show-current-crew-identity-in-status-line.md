---
id: TASK-0094
title: Show current crew identity in status line
status: done
depends_on: []
priority: high
tags: [crew, membership, status-line, ui, identity, regression, tdd]
---

# Show current crew identity in status line

## Problem
A joined Pi session shows only generic joined state in the Bebop status line, so operators cannot tell at a glance which crew member and role the session currently owns. This makes multi-session coordination error-prone.

## Desired outcome
When a session is joined, the Bebop status line identifies the exact current crew member and role using the trusted membership snapshot. The separate Pi intray status remains responsible for session-id visibility.

## Acceptance criteria
- [x] Tests first capture joined and unjoined status-line behavior before implementation.
- [x] A joined Bebop status line includes the exact current member as `joined Name (role)`; for example, `joined Mary (po)`.
- [x] Identity comes only from the active trusted membership runtime, never CLI input, role inference, aliases, socket filenames, or cached display text.
- [x] The Bebop footer does not duplicate the session ID; Pi intray retains the session-ID display responsibility.
- [x] Runtime join, same-session role switch, and membership refresh replace the displayed identity immediately.
- [x] Leave, failed restore, unjoined startup, stop, and shutdown remove member name and role immediately; stale identity is never displayed.
- [x] Existing `online`, `joined`, and disabled status semantics remain distinct. Unjoined status contains no placeholder or guessed identity.
- [x] Status text exposes only member name and role—never instructions, description, manifest path, socket path, contact, or other roster members.
- [x] Repeated refresh is deterministic and stale Pi UI contexts remain safely ignored as today.
- [x] Focused status lifecycle/privacy tests, typecheck, lint, package verification, and watcher gate pass.

## Evidence

- Focused coverage in `src/pi/control-runtime.test.ts`: identity rendering, role-switch replacement, privacy, stale context, stop/leave clearing, and status-key usage.
- Verification: focused suite 41/41; pre-commit full test hook 946/946; watcher generation 7 passed `npm test`, `npm run format:check`, `npm run lint`, and `make all`.
- Cherry-picked experiment commits: `444afd6`, `4b67280`, `76eab37`, `c3501a3`, and `bf91c2e` (with the incompatible startup integration test omitted because this branch has no `src/pi/session-start.ts`).

## Non-goals
- Showing other crew members, presence, activity, Focus, task progress, or pending messages.
- Making status-line identity an authentication or availability signal.
- Changing CLI output, `/crew members`, session aliases, or membership selection.

## Product decision
Use `joined Name (role)` for the Bebop footer. Keep session-id-first ordering in the separate Pi intray footer; do not duplicate it in `pi-bebop`.

