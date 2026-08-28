# TASK-0088 CLI migration slice — member status

Migrated `member status` usage and operational failures to the shared Actionable Error presenter. Existing status and exit behavior remains unchanged (usage exit 2, operational exit 1, successful observed/offline status exit 0). Added public-envelope assertions for operation, safe member location, recovery, and JSON output.

Also hardened the direct-render guard to recognize a real presenter-backed CLI error construction across its bounded source window without trusting comments/identifiers; guard remains PASS at 24 entries.

Evidence:
- `src/cli/commands/member-status.test.ts`: 19/19 PASS
- `src/cli/errors.test.ts`: included; 24/24 combined PASS
- typecheck, architecture, guard PASS
- watcher gen 364 PASS/current (`format:check`, `make all`)

Adapter migration is ongoing; this slice does not claim TASK-0088 completion.
