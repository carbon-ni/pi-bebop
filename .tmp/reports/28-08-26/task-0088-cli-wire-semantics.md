# TASK-0088 CLI wire semantics correction

Added existing stable transport codes (`offline`, `offline-session`, `timeout`, `aborted`, `transport-error`, `unknown-session`) to member-message remote-code allowlist. This preserves the real-wire `offline` outcome instead of incorrectly normalizing it to `remote-rejected`, while unknown/path-bearing codes remain rejected and genericized.

Evidence:
- Real-wire member-message integration + focused suite: 20/20 PASS.
- Watcher gen450 `@agent-final`: PASS/current.
- Typecheck PASS.

Only `src/cli/commands/member-message.ts` was staged; concurrent TASK-0128–0132 plan edits were left untouched.
