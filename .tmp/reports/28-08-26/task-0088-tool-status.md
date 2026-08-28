# TASK-0088 tool slice — get_member_status

Migrated get_member_status error paths to the shared actionable tool envelope. Raw flow/transport exception messages are no longer rendered; operation, safe member locator, recovery, compatibility code, and canonical message are structured consistently.

Evidence: get-member-status focused 6/6; watcher gen487 `@agent-final` PASS/current; typecheck and guard pass. Remaining registered tools and Pi/startup/lifecycle adapters are pending.
