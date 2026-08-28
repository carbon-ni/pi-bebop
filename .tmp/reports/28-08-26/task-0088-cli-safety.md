# TASK-0088 CLI safety remediation

Addressed independent QA findings:
- Unknown `Error` causes now map to `unexpected-failure` rather than fabricated `offline`.
- Unknown raw exception text is replaced by a generic safe reason; dependency/temp details do not cross CLI output.
- Compatibility `target` derives only from retained presenter location; socket/temp and detector-changed values are omitted.
- Added public `send` regression covering unknown dependency error, text output, JSON/TOON-safe target behavior, and exit 1.

Evidence:
- Full suite: 1361/1361 PASS.
- Watcher gen398: PASS/current (`npm test`, format check, lint, `make all`).
- Guard and architecture pass.

Await Kelly re-review. Tools and Pi adapters remain pending.
