# TASK-0088 broadcast partial QA

Added an injected partial-failure envelope regression. It verifies canonical content/message identity, stable partial code, retained broadcast summary, and raw recipient error suppression inside actionableError.

Evidence: focused suite 4/4; watcher gen528 PASS/current; typecheck PASS. Kelly re-review requested.
