# TASK-0088 shared closed CLI code mapper

Promoted closed error-code normalization to `normalizeCliErrorCode` in `src/cli/errors.ts`; member-message now delegates to it instead of maintaining a local REMOTE_CODES set. Grammar-valid but unrecognized remote values (for example `password-secret`) become `unexpected-failure`; known transport codes including `offline` remain stable. Durable, interrupt, and idle CLI callers pass through the same `errorResult` normalization.

Evidence: member-message real-wire/unit plus durable/interrupt/idle/errors focused matrix 27/27 PASS; typecheck PASS. Current full suite was 1361/1361 before this normalization-only change; run fresh watcher gate after commit. No plan files staged.
