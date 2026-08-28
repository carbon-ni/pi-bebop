# TASK-0088 broadcast details sanitization

Constrained partial-failure structured details to the safe broadcast summary projection, omitting arbitrary recipient/error payloads that could carry raw paths. Regression now verifies recipients and private paths are absent from serialized details.

Evidence: focused 4/4; watcher gen531 PASS/current; typecheck PASS. Kelly re-review requested.
