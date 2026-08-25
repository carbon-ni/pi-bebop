# TASK-0091/0092 implementation

Implemented scoped package preparation and release automation.

- Renamed package identity to `@carbon-ni/pi-bebop`, kept `pi-bebop` bin and extension entrypoint, set `publishConfig.access=public`, and refreshed lock metadata.
- Strengthened package verification with identity, public-access, required-file, allowlist, repository-local leakage, and executable CLI checks; updated isolated consumer paths for scoped installs.
- Updated README install guidance while honestly retaining unpublished status.
- Added `.github/workflows/release.yml`: only `release.published`, tag/version gate, quality gate, OIDC permissions, one artifact/checksum, npm public publish without provenance claims, and GitHub release attachment.

Verification: `npm run format:check`, `npm run verify:package`, `npm run check:package-json`, `npm run build`, and `npm run verify:readme` passed. External watcher was green before final edits (`gen=107`, `make all`).
