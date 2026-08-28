# TASK-0088 broadcast canonical partial error

Fixed partial broadcast failures so content is produced directly by actionableToolError and is byte-identical to actionableError.message. Broadcast summary/recipient details remain structured-only.

Evidence: focused 3/3; typecheck PASS; watcher gen524 PASS/current. Kelly re-review requested.
