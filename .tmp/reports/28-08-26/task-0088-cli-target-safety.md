# TASK-0088 CLI target safety remediation

Fixed the compatibility `CliResult.target` field to derive only from the retained Actionable Error location. Unsafe detector-changed target values now become `""` in text-independent JSON/TOON envelopes; safe values remain available. Added JSON and TOON regressions for credential-bearing URL and safe target cases.

Evidence:
- Focused errors/member-status suites: 25/25 PASS.
- Watcher gen 390: PASS/current (`npm test`, format check, lint, `make all`).
- Guard and typecheck pass.

Kelly QA re-review required; remaining tool/Pi adapter migration is not included.
