---
id: TASK-0093
title: Verify release consumption and document operations
status: todo
depends_on: [TASK-0092]
priority: high
tags: [release, verification, npm, docs, recovery]
---

# Verify release consumption and document operations

## Problem
A successful publish job does not prove users can install and run the package, and npm versions cannot be overwritten. Maintainers need consumer evidence and a clear recovery path before announcing a release.

## Desired outcome
A maintainer can prove the released package works from the same public path users follow, update product documentation from verified facts, and recover safely from a bad or partial release.

## Acceptance criteria
- [ ] Post-publication verification resolves the exact expected version from npm and confirms its package identity, distribution tag, and checksum against the GitHub Release artifact.
- [ ] Documentation explicitly records that npm provenance is unavailable while the source repository is private and does not present checksum comparison as equivalent provenance.
- [ ] A clean consumer installs the exact npm version, runs CLI help plus one non-mutating command, and loads the extension through the supported Pi host using production dependencies only.
- [ ] Stable verification proves `latest` points to the released stable version; prerelease verification proves `latest` was not moved.
- [ ] README installation guidance changes to `npm install --global @carbon-ni/pi-bebop` only after the public package path succeeds, and states the verified version and supported Pi range without stale unpublished claims.
- [ ] A release runbook documents authorization, required npm/GitHub configuration, normal release steps, evidence, safe rerun, partial publication, deprecation, and corrective-release procedures.
- [ ] Recovery guidance never recommends overwriting an npm version; unpublish is reserved for exceptional policy-qualified incidents rather than routine rollback.
- [ ] The first real release's evidence and any manual operator steps are recorded in the task notes before completion.

## Non-goals
- Announcing or promoting a release before post-publication verification succeeds.
- Automating semantic-version selection or release approval.

