# Remove Markdown quality gates

Implemented in commit `d21e65c`.

- Removed `verify:readme` from package scripts and Makefile quality gate.
- Removed README and member-request Markdown checker scripts/tests.
- Kept Markdown/docs packaging allowlists and restored existing local docs files unchanged.
- Removed README-required-file assertion from package verification while retaining non-Markdown package checks.

Verification: `check:package-json`, `verify:package`, and `npm test` passed (943 tests). No remote actions.
