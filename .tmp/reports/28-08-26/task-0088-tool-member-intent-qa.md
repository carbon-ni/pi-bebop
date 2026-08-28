# TASK-0088 member-intent tool QA remediation

Expanded member intent tool tests for both `send_follow_up` and `redirect_member`: typed `MemberMessageError` and raw dependency failures now assert actionableError existence, compatibility code parity, byte-identical content/message, and suppression of path-bearing details.

Implementation remains in 694dc88; this follow-up only strengthens the test contract.

Evidence: member-tool suite 12/12; watcher gen490 `@agent-final` PASS/current; typecheck PASS. Kelly re-review required.
