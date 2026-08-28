# TASK-0088 CLI generic failure safety

Fixed the remaining CLI safety gap identified against e89953d:
- `operational` generic helper results now normalize to `unexpected-failure` with a safe generic reason.
- Presenter locator policy omits traversal, temp (`/tmp`, `/private/tmp`, macOS `/var/folders`), and socket paths.
- Added public `crew init --project <file>` regressions across text, JSON, and TOON proving ENOTDIR, temp paths, and target/location leakage are absent.

Evidence:
- Focused errors/crew-init tests: 14/14 PASS.
- Full suite: 1361/1361 PASS.
- Watcher gen403: PASS/current (`npm test`, format check, lint, `make all`).
- Typecheck, guard, architecture pass.

Kelly re-review required. Remaining tools and Pi adapters are not migrated.
