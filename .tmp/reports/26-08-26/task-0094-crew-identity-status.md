# TASK-0094: Crew identity in status line

## Change
- `formatIntrayFooter` now appends trusted `Name (role)` only for `joined`, while preserving full session id first.
- `updateStatus` reads identity from the active `MembershipRuntime` snapshot; online/stopped output never includes identity.
- Startup socket/role joins and persisted restore refresh the status immediately after membership becomes active.
- Existing runtime join/leave/role-switch refresh hooks remain in the control-command path, and clearing membership removes identity.
- `.watch.yaml` explicitly ignores build-lock artifacts so the broad quality job does not retrigger on its own ignored lock files.

## Evidence
- Focused control-runtime status tests: 36/36 pass, including joined/unjoined formatting, identity transition, and stale identity removal.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run verify:package`: pass in isolated consumer/Pi host loader.
- Commit pre-hook: 948/948 tests pass.
- Funzzy gen 217 passed `npm test && npm run format:check && npm run lint && make all` (948/948, after the concurrent CLI flake fix landed). Earlier gen 210 reported 947/948 from the pre-existing `rpc-client` offline terminal-close race; gens 208/209 failed acquiring a stale/superseded `.bebop-build.lock`; the stale lock was removed and watcher ignores were added.

## Commit
- `444afd6 feat: show crew identity in status line`

## QA handoff
Independent QA review is required for startup restore/join, runtime role switch/refresh, stale identity removal, session-id-first ordering, and non-disclosure of paths/instructions/roster data.
