# TASK-0088 request flow acquisition QA

Corrected the regression to explicitly clear memberRequestFlow before registering wait_for_request_outcome, exercising flowFor acquisition failure and its actionable catch. Asserted canonical parity and raw suppression.

Evidence: focused 9/9; watcher gen553 PASS/current. Kelly re-review requested.
