# TASK-0106 trusted Agreement activation

## Implementation

Commit `22ffdf3` implements explicit `/crew agreements activate <revision-id>` activation.

- `src/application/crew-agreement-activation.ts`: trusted-project preflight, commit-before-notify orchestration, deterministic per-member notice IDs, partial fan-out outcomes.
- `src/infra/crew-agreement-activation-store.ts`: canonical current-file validation, exact base checks, lock-serialized activation, atomic journal/current/state/revision writes, and crash recovery.
- `src/infra/crew-agreement-store.ts`: activation store surface and persisted activation-state status projection.
- `src/domain/crew-agreement-activation.ts`: bounded redacted system notice and deterministic activated content.
- `src/domain/cli.ts`, `src/pi/control-commands.ts`, `src/extension.ts`: explicit command and composition wiring.
- `src/pi/session-start.ts`: extracted startup composition to keep the architecture gate below limits.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Trusted authority only | Application rejects untrusted projects before opening Agreement or Inbox stores; integration test covers zero-I/O preflight. Origin/role are not used as authority. |
| Exact base and fail-closed validation | Integration tests cover external authority, stale base, corrupt activation state, current snapshot preservation, and candidate/reference validation. |
| Atomicity and recovery | `.activation-pending.json` journals the next content, state, and activated revision; recovery completes either prior or next coherent state. All publications use temp-file rename. |
| Replay/concurrency | Store activation runs under the existing lock; same durable current revision returns `unchanged`; deterministic notice IDs make partial retries idempotent. |
| No hot reload | Activation operates on persisted Current Crew Agreements and does not mutate the active Membership snapshot. |
| Notices | Notice is bounded/redacted; activation commits before per-member Inbox enqueue. Partial member failure is reported without rollback. |
| CLI/control | Parser and control-command tests cover `agreements activate` and malformed subcommands; control output returns activation disposition and notice outcomes. |
| Architecture | Isolated `git archive 22ffdf3` snapshot with dependencies linked: `make arch-check` => no violations. |

## Checks

- `npx tsc --noEmit`: passed.
- Targeted activation/store/control tests: passed (24 tests in the final targeted run; 4 activation integration tests all passed).
- `npm run lint`: passed before commit.
- `git diff --cached --check`: passed.
- Full hook was attempted; its shared worktree run was blocked by unrelated TASK-0113 architecture files, and one full-suite run had an unrelated flaky failure. The isolated commit snapshot still needs the final independent Kelly/final-gate verification.

## Ownership / limitations

Only TASK-0106 files are in `22ffdf3`. Mary’s TASK-0113 files remain untracked and untouched. Kelly was handed the isolated commit for independent verification; no completion or approval claim is made here.
