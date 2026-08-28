# TASK-0088 CLI adapter migration

## Changes
- CLI `usageResult` and `errorResult` now construct the shared Actionable Error presentation while retaining `CliResult` status/exit semantics.
- Added operation-specific operation labels to frozen CLI error call sites (send, crew init/roles, member status/message/interrupt/wait-idle, session list).
- CLI `CliResult.error` accepts the additive full Actionable Error model; text renderer continues using the canonical message and JSON/TOON carry the same structured error.
- Added real `member status` public-boundary envelope assertions.

## Evidence
- CLI migration focused suites: 105/105 PASS.
- Guard: PASS (24 entries).
- Architecture and typecheck: PASS.
- Previous watcher gen364 and latest commit-hook runs passed full 1360-test suite; fresh adapter edits require Kelly re-review.

## Remaining
Tool, `/crew`, startup, lifecycle, and any stricter CLI safe-target policy remain for later bounded slices. TASK-0088 is not complete.
