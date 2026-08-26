---
id: TASK-0094
title: Show current crew identity in status line
status: doing
depends_on: []
priority: high
tags: [crew, membership, status-line, ui, identity, regression, tdd]
---

# Show current crew identity in status line

## Problem
A joined Pi session shows only its session id and generic joined state in the status line, so operators cannot tell at a glance which crew member and role the session currently owns. This makes multi-session coordination error-prone.

## Desired outcome
When a session is joined, its status line identifies the exact current crew member and role using the trusted membership snapshot, while preserving existing session-id and lifecycle visibility.

## Acceptance criteria
- [x] Tests first capture joined and unjoined status-line behavior before implementation.
- [x] A joined status line includes the exact current member as `Name (role)`; for example, `<session-id> joined Mary (po)`.
- [x] Identity comes only from the active trusted membership runtime, never CLI input, role inference, aliases, socket filenames, or cached display text.
- [x] The full local session id remains first so existing copyability and truncation priority from TASK-0006 do not regress.
- [x] Startup restore, runtime join, same-session role switch, and membership refresh replace the displayed identity immediately.
- [x] Leave, failed restore, unjoined startup, stop, and shutdown remove member name and role immediately; stale identity is never displayed.
- [x] Existing `online`, `joined`, and disabled status semantics remain distinct. Unjoined status contains no placeholder or guessed identity.
- [x] Status text exposes only member name and role—never instructions, description, manifest path, socket path, contact, or other roster members.
- [x] Repeated refresh is deterministic and stale Pi UI contexts remain safely ignored as today.
- [ ] Focused happy/unhappy lifecycle tests, typecheck, lint, package verification, and watcher gate pass (watcher gen 210 has one unrelated pre-existing rpc-client race).

## Evidence

See `.tmp/reports/26-08-26/task-0094-crew-identity-status.md` and commit `444afd6`.

## Non-goals
- Showing other crew members, presence, activity, Focus, task progress, or pending messages.
- Making status-line identity an authentication or availability signal.
- Changing CLI output, `/crew members`, session aliases, or membership selection.

## Product decision
Use the same ubiquitous identity format already used elsewhere: `Name (role)`. Preserve full session-id-first ordering; identity remains visible when terminal width permits rather than displacing the copyable session id.

