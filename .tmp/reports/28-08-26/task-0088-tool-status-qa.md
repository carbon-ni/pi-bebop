# TASK-0088 get_member_status QA remediation

Expanded tests to assert actionableError presence, compatibility code parity, exact content/message identity, and raw exception suppression for unjoined and transport failures. Implementation remains 5389737.

Evidence: focused get_member_status 7/7; watcher gen493 `@agent-final` PASS/current; typecheck PASS. Kelly re-review required.
