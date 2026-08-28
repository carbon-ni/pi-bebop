# TASK-0088 CLI send mapping audit

Removed raw exception messages from the public `send` adapter. Send failures now map to closed factual reasons by stable code (`aborted`, `timeout`, `offline`, generic), while unknown codes remain `unexpected-failure`; target/location safety stays enforced by the shared presenter.

Evidence: send focused 10/10; guard PASS (23 entries); watcher gen419 `@agent-final` PASS/current; typecheck and prior full suite PASS.

CLI adapters remain in progress; tools and Pi surfaces are pending.
