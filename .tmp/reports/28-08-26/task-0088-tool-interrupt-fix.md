# TASK-0088 interrupt_member mapper fix

Fixed remote response-code leakage: interrupt_member now maps remote codes through a closed vocabulary, converting unknown/untrusted values such as `password-secret` and path-bearing codes to `unexpected-failure`. Added regression coverage.

Evidence: focused suite 5/5; watcher gen503 PASS/current; typecheck PASS. Kelly re-review requested.
