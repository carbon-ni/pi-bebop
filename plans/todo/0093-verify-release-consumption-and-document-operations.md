---
id: TASK-0093
title: Verify release consumption and document operations
status: todo
depends_on: [TASK-0092]
priority: high
tags: [release, verification, npm, docs, recovery, external-operator, blocked]
---

# Verify release consumption and document operations

## Problem
A successful publish job does not prove users can install and run the package, and npm versions cannot be overwritten. Maintainers need consumer evidence and a clear recovery path before announcing a release.

## Desired outcome
A maintainer can prove the released package works from the same public path users follow, update product documentation from verified facts, and recover safely from a bad or partial release.

## Operator sequence
1. Merge the verified release work to `main`; do not release from the local `dev` branch.
2. Add and verify exact public package repository metadata for `https://github.com/carbon-ni/pi-bebop` before packing; npm trusted publishing requires it to match the GitHub repository.
3. Create and push tag `v0.1.0` at the exact release commit. A tag alone does not trigger publication.
4. Build and verify the canonical tarball from that tag using the pinned Node/npm release toolchain.
5. Cristian signs into npm with 2FA and manually publishes that exact tarball to bootstrap `@carbon-ni/pi-bebop@0.1.0`; credentials and OTP remain with Cristian.
6. In npm package settings, configure the GitHub Actions trusted publisher for `carbon-ni/pi-bebop`, workflow `release.yml`, no environment, with `npm publish` permission; then disallow traditional token publishing.
7. Publish the GitHub Release for existing tag `v0.1.0`. This sole trigger resumes against the identical npm artifact, attaches tarball/checksum, and fails closed on any byte mismatch.
8. Run public-registry consumer checks before updating documentation or announcing the release.

## Acceptance criteria
- [ ] Before bootstrap publication, `package.json` repository metadata exactly identifies `https://github.com/carbon-ni/pi-bebop` and package verification enforces it.
- [ ] Post-publication verification resolves the exact expected version from npm and confirms its package identity, distribution tag, and checksum against the GitHub Release artifact.
- [ ] Documentation explicitly records that npm provenance is unavailable while the source repository is private and does not present checksum comparison as equivalent provenance.
- [ ] A clean consumer installs the exact npm version, runs CLI help plus one non-mutating command, and loads the extension through the supported Pi host using production dependencies only.
- [ ] The public npm package independently supports both entrypoints: `npm install --global @carbon-ni/pi-bebop@0.1.0` exposes `pi-bebop`, and `pi install npm:@carbon-ni/pi-bebop@0.1.0` loads the extension.
- [ ] Stable verification proves `latest` points to the released stable version; prerelease verification proves `latest` was not moved.
- [ ] README installation guidance changes to `npm install --global @carbon-ni/pi-bebop` only after the public package path succeeds, and states the verified version and supported Pi range without stale unpublished claims.
- [ ] A release runbook documents authorization, required npm/GitHub configuration, normal release steps, evidence, safe rerun, partial publication, deprecation, and corrective-release procedures.
- [ ] Recovery guidance never recommends overwriting an npm version; unpublish is reserved for exceptional policy-qualified incidents rather than routine rollback.
- [ ] The first real release's evidence and any manual operator steps are recorded in the task notes before completion.

## Current blocker

This task requires Cristian's npm/GitHub operator actions and public-registry
evidence. It is not active until that operator sequence starts.

## Non-goals
- Announcing or promoting a release before post-publication verification succeeds.
- Automating semantic-version selection or release approval.

