# TASK-0088 request tools slice

Migrated member request failure paths to actionableToolError with a closed request-code vocabulary and safe generic reasons. Added canonical envelope assertions to the empty-wait regression, including serialized-details raw suppression.

Evidence: focused member-request suite 7/7; watcher gen543 PASS/current; typecheck PASS. Kelly review requested.
