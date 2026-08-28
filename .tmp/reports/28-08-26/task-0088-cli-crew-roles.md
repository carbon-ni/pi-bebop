# TASK-0088 CLI crew-roles mapping

Known `CrewManifestReadError`/`CrewManifestError` messages are now mapped to closed operation-specific descriptors; raw manifest/path/dependency text is never used as reason. Unknown failures use `unexpected-failure`. Added real `crew roles` text/JSON/TOON regression with a path-bearing read error and verified stable code plus no leakage.

Evidence:
- Crew roles focused suite: 17/17 PASS.
- Guard and typecheck: PASS.
- Watcher gen409 `@agent-final`: PASS/current after clearing a stale build lock; package dry-run PASS.

Kelly re-review required. Other CLI/tool/Pi boundaries remain pending.
