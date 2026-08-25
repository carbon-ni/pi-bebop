---
id: TASK-0092
title: Automate trusted GitHub and npm publishing
status: todo
depends_on: [TASK-0091]
priority: high
tags: [release, github-actions, npm, oidc, security]
---

# Automate trusted GitHub and npm publishing

## Problem
Releases currently require manual artifact and registry operations, making provenance, consistency, and reruns unreliable. A release should publish one verified package artifact through least-privilege automation.

## Desired outcome
An explicitly authorized release produces and verifies one tarball, publishes those exact bytes to GitHub and npm, and leaves auditable evidence without exposing a durable registry credential.

## Acceptance criteria
- [ ] Release automation starts only from the trigger and approval defined by TASK-0090; pull requests and ordinary branch pushes cannot publish.
- [ ] It requires the repository quality gate and rejects any mismatch among Git tag, GitHub Release, and `package.json` version before publication.
- [ ] It builds once, runs package and clean-consumer verification, then publishes the same tarball to npm and attaches it to the GitHub Release with SHA-256 checksum and release notes.
- [ ] npm publication uses trusted publishing/OIDC and public package access. Workflow permissions are minimal and no long-lived npm token is stored or consumed.
- [ ] Automation and release output state honestly that npm provenance is unavailable while the source repository is private; absence of provenance does not silently fail publication.
- [ ] Stable releases publish under `latest`; prereleases publish under the contract's non-`latest` distribution tag.
- [ ] A concurrency guard prevents overlapping publication for the same release.
- [ ] Reruns detect already-published versions and assets. They either prove the existing artifact is identical or stop with an actionable mismatch; they never overwrite or silently rebuild release bytes.
- [ ] Partial GitHub/npm failures remain visible and can resume only the missing matching publication step without creating a second artifact.
- [ ] Workflow and supporting-script tests cover stable, prerelease, version mismatch, duplicate-identical, duplicate-mismatch, failed gate, and partial-publication paths without contacting GitHub or npm.

## Constraints
Remote trusted-publisher configuration is an authorized operator step and must be documented rather than guessed by automation. Environment approval is used only when supported by the current GitHub plan; no workflow may claim unavailable private-repository protection.

