# TASK-0088 broadcast typed summary fix

Typed and validated partial broadcast summary projection. Broadcast IDs now accept only bounded safe tokens; numeric summary fields require safe integers; arbitrary recipient/error payloads are excluded. Exported mapper regression coverage for actual codes and unknown-code rejection.

Evidence: focused 4/4; watcher gen536 PASS/current; typecheck PASS. Kelly re-review requested.
