# TASK-0088 broadcast mapper fix

Incorporated actual broadcast result codes: not-joined, unknown-sender, invalid-request, and untrusted-project; removed non-emitted not-configured-member. Partial failed broadcasts now use actionableToolError while retaining broadcast summary details.

Evidence: focused 3/3; watcher gen520 PASS/current; typecheck PASS. Kelly re-review requested.
