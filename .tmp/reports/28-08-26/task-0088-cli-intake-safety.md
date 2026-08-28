# TASK-0088 CLI send --crew intake safety

Added a public boundary regression for known `ExternalIntakeError` with a path-bearing message. Across text, JSON, and TOON, stable `read-failed` is preserved while raw message and unsafe socket/temp target are absent. This validates the shared send mapping after the historical 52027df/e89953d findings.

Evidence: send focused 11/11; guard PASS (23); watcher gen422 `@agent-final` PASS/current; typecheck pass. No production behavior change was needed because cac2f98 already maps the boundary through closed safe reasons.
