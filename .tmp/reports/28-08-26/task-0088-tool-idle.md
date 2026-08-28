# TASK-0088 wait_for_member_idle slice

Migrated wait_for_member_idle error paths to actionableToolError and added direct unjoined envelope parity/raw-suppression assertions. Existing blocking/message/offline/timeout behavior remains covered.

Evidence: focused 12/12; watcher gen558 PASS/current; typecheck PASS. Kelly review requested.
