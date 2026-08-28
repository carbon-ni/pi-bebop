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
- [x] Focused happy/unhappy lifecycle tests, typecheck, lint, package verification, and watcher gate pass (watcher gen 270 green; the gen 210 rpc-client race was resolved by the concurrent CLI flake fix; gen 267 failed only on transient `.bebop-build.lock` contention across overlapping generations).

## Evidence

See `.tmp/reports/26-08-26/task-0094-crew-identity-status.md`, `.tmp/reports/28-08-26/task-0094-qa-blockers-remediation.md`, and commit `444afd6`.

QA blocker remediation (26-08-26 review verdict BLOCKED):
- `.watch.yaml` build-lock ignores cover the lock directory itself and descendants (exact `.bebop-build.lock` + `.bebop-build.lock/**`, plus `.bebop-build-*` staging equivalents). The lock is a directory containing an `owner` file, not a plain file as the review assumed.
- New focused coverage: same-session role-switch identity replacement, privacy-only status output (full roster/manifest fixture leaks nothing), stale-context swallow, stop/shutdown identity clear, startup restore `online -> joined` refresh, failed restore keeps identity-free online, unjoined startup sets no status line (`src/pi/control-runtime.test.ts`, `src/pi/session-start.status.integration.test.ts`).
- Verification: focused suites 43/43 + 33/33; typecheck (both configs), lint, format-check, arch-check, build green via watcher gen 270; `npm run verify:package` passed in isolated consumer/Pi host loader.

## Non-goals
- Showing other crew members, presence, activity, Focus, task progress, or pending messages.
- Making status-line identity an authentication or availability signal.
- Changing CLI output, `/crew members`, session aliases, or membership selection.

## Product decision
Use the same ubiquitous identity format already used elsewhere: `Name (role)`. Preserve full session-id-first ordering; identity remains visible when terminal width permits rather than displacing the copyable session id.

