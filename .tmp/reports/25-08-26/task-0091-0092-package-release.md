# TASK-0091/0092 implementation

Implemented scoped package preparation and release automation.

- Renamed package identity to `@carbon-ni/pi-bebop`, kept `pi-bebop` bin and extension entrypoint, set `publishConfig.access=public`, and refreshed lock metadata.
- Strengthened package verification with identity, public-access, required-file, allowlist, repository-local leakage, and executable CLI checks; updated isolated consumer paths for scoped installs.
- Updated README install guidance while honestly retaining unpublished status.
- Added `.github/workflows/release.yml`: only `release.published`, tag/version gate, quality gate, OIDC permissions, one artifact/checksum, npm public publish without provenance claims, and GitHub release attachment.

Verification: `npm run format:check`, `npm run verify:package`, `npm run check:package-json`, `npm run build`, and `npm run verify:readme` passed. Follow-up commit `6713838` removes all provenance wording from the workflow while retaining OIDC and omitting `--provenance`. Commit `632e949` pins Node 22.14/npm 11.5.1, adds package verification to the pre-publish gate, and makes npm/GitHub publication resumable with duplicate-identical/mismatch and partial-publication tests. Local package verification and all 940 tests pass.
