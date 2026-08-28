# TASK-0088 interrupt stable-code fix

Expanded the interrupt tool’s closed remote-code vocabulary to preserve stable outcomes: already-pending, abort-failed, no-context, handoff-failed, and outcome-unknown. Unknown/path-bearing codes remain normalized to unexpected-failure. Added mapper regressions.

Evidence: focused suite 5/5; watcher gen506 PASS/current; typecheck PASS. Kelly re-review requested.
