---
id: TASK-0142
title: Restore Crew Board append for active Members
status: doing
depends_on: []
priority: high
tags: [crew, board, collaboration, regression, tdd]
---

# Restore Crew Board append for active Members

## Problem

The interim TASK-0140 retrospective could be read from the Crew Board but could not be persisted: both Mary and Mony received `board-failed` from `leave_crew_post` while active Membership sockets and Board reads remained valid. Repeated retries provide no new evidence and the shared retrospective has no durable Post ID.

## Context

The existing Board contains one healthy Post and `read_crew_board` succeeds. The append directory is below capacity and no lock or temporary file is visible. This narrows the observed failure to the append authorization, validation, or write path. Public error sanitization currently hides the underlying unknown failure, so diagnosis must preserve privacy while producing stable actionable evidence.

Do not bypass Membership attribution or write Board files manually to publish the retrospective.

## Acceptance criteria

- [x] Add a failing regression fixture reproducing append rejection while the same active trusted Membership can read the Board (`src/tools/crew-board.test.ts`, realistic `call_*|fc_*` ID; red before grammar fix, read succeeded).
- [x] Cover both Mary/Product and Mony/Lead membership snapshots without inferring authority from Role (`src/tools/crew-board.test.ts`, active Membership loop).
- [x] Identify the exact append-path failure and fix it without weakening operation-ID, author, trust, layout, link, capacity, locking, or atomic-publish validation: Pi tool-call IDs can contain `|fc_...`; the operation identity is hashed and never persisted, so the bounded grammar now accepts `|` (`src/domain/crew-board.ts`, `docs/CREW-BOARD.md`).
- [x] Known append failures retain bounded stable error codes and recovery guidance; unknown exceptions remain sanitized without making diagnosis impossible in tests or internal evidence (`src/tools/crew-board.test.ts`, existing known/unknown error matrix).
- [x] A real extension-host test persists one Post through `leave_crew_post`, returns a Post ID, and reads the same canonical Post back through `read_crew_board` (`src/pi/crew-board.host.integration.test.ts`).
- [x] Exact replay remains idempotent; a distinct operation creates a distinct Post; no retry creates duplicates (`src/infra/crew-board-store.test.ts`, replay/conflict/concurrent append matrix).
- [ ] After the fix, persist the exact agreed interim TASK-0140 retrospective synthesis once on the actual shared project Crew Board and record its Post ID in the retrospective report. The temporary fixture Post `post-03a79769b23b52c76174f546acace99219d20b0f263d759a066a70193004042b` is explicitly not acceptance evidence.
- [x] Focused tests, full gates, fresh watcher, and independent exact-head QA pass: Kelly verified detached exact `ae0feb9c9bc32a8801549d67241814e95990ede7`, `make all` exit 0, Board 35/35, arch 34/34, typecheck, and diff-check.

## Notes

Observed on commit `51947eb`: Board read succeeded, while append attempts by Mary and Mony returned `board-failed`. No Post ID was created.

