# TASK-0088 CLI session-list mapping

Migrated unreadable control-store failure to a closed descriptor, avoiding raw store path/error output. Added path-bearing regression and ratcheted the guard baseline from 24 to 23 entries after removing the direct render.

Evidence: session-list focused 10/10; guard PASS (23 entries); watcher gen414 `@agent-final` PASS/current; typecheck pass.

CLI migration remains in progress; tools and Pi adapters are pending.
