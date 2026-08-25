---
id: TASK-0090
title: Define deterministic release contract
status: todo
depends_on: []
priority: high
tags: [release, product, npm, github, security, determinism]
---

# Define deterministic release contract

## Problem
The repository has CI and package verification, but it has no explicit release authority, artifact identity, version rules, or failure policy. Publishing without one risks mismatched GitHub and npm artifacts, accidental latest releases, and unrecoverable operator mistakes.

## Desired outcome
Maintainers have one reviewable release contract that defines when a release starts, which bytes are published, how versions and channels map, what proves success, and how partial failure is handled.

## Acceptance criteria
- [ ] Define the sole release trigger and authority, including required approval and the relationship between Git tag, GitHub Release, and `package.json` version.
- [ ] Define the canonical artifact as one verified `npm pack` tarball published unchanged to GitHub Releases and npm, accompanied by its SHA-256 checksum and release notes.
- [ ] Define stable and prerelease behavior: stable versions use npm `latest`; prereleases use a non-`latest` distribution tag such as `next`.
- [ ] Define the required pre-publication gates: existing CI, package verification, clean consumer installation, CLI smoke test, and extension-host loading.
- [ ] Define least-privilege publication through npm trusted publishing/OIDC with provenance, protected environment approval, and no long-lived npm token.
- [ ] Define deterministic rerun and partial-failure behavior. Existing npm versions are never overwritten; a release is not announced until both destinations and post-publication checks succeed.
- [ ] Define checksum, provenance, version, and destination evidence retained for each release.

## Non-goals
- Automatically choosing or bumping the next semantic version.
- Maintaining an additional unscoped `pi-bebop` npm package.
- Claiming atomic publication across GitHub and npm; partial publication must instead be visible and recoverable.

## Constraints
No tag, GitHub Release, npm package, trusted-publisher setting, or other remote release state may be created or changed without explicit authorization.

