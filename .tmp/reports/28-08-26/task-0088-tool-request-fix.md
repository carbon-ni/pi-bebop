# TASK-0088 request tool blocker fix

Expanded request-tool stable vocabulary for emitted local outcomes (`no-pending-request`, `response-expired`, `ambiguous-member`, `invalid-payload`) and moved flow acquisition inside wait error boundary so initialization throws become actionable envelopes. Response code parsing now rejects unknown raw codes.

Evidence: focused 7/7; watcher gen546 PASS/current; typecheck PASS. Kelly re-review requested.
