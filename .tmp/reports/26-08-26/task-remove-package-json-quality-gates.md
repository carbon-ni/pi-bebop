# Remove package.json quality gates

Implemented in commit `78cef3e`.

- Removed `check-package-json` script and Makefile `package-check` target/wiring.
- Removed package.json from format-check/format-write validation globs.
- Kept package functionality, build, release verification, and non-package quality checks intact.

Verification: `npm run format:check` and `npm test` passed (943 tests). No remote actions.
