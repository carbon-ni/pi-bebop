# TASK-0088 CLI closed mappings

Closed the remaining known CLI mapping gap found in detached `35ffd08`: `crew roles` now maps `CrewManifestReadError` and `CrewManifestError` through operation-specific descriptors, preserving typed codes while discarding raw message/path content. Added real public text/JSON/TOON regression for path-bearing `read-failed`.

Also migrated `crew init` typed flow failures to a closed descriptor rather than copying the application message.

Evidence:
- Focused crew-init/crew-roles tests: 25/25 PASS.
- Full watcher gen411 `@agent-final`: PASS/current.
- Guard/typecheck/architecture pass.

Kelly re-review required; tools and Pi adapters remain pending.
