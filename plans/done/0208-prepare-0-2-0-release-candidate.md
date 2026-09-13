---
id: TASK-0208
title: Prepare 0.2.0 release candidate
status: done
depends_on: []
priority: high
tags: [release, npm, github, package, documentation, safety]
---

# Prepare 0.2.0 release candidate

## Problem
npm already publishes 0.1.0 while the repository lacks a matching GitHub tag/release and has substantial post-release features; a reviewed release candidate must reconcile version, notes, and package verification before any authorized publication.

## Context

Registry evidence establishes `@carbon-ni/pi-bebop@0.1.0` as public and
`latest`, published on 2026-08-26. There are no matching GitHub releases or
release tags; historical release run `32929506597` passed quality but failed
its npm publication step, so its eventual npm publication provenance is not
reconstructable. Current source has substantial post-0.1 functionality.

## Acceptance criteria
- [x] `package.json` and root lockfile declare `0.2.0`; package verification derives the package version rather than duplicating it.
- [x] Release notes state user-visible additions and the `crew session` to `session` command migration without claiming publication.
- [x] README no longer says the public npm package is unpublished and uses the candidate tarball version consistently.
- [x] Existing release workflow identity/artifact checks and stable/prerelease semantics remain unchanged.
- [x] Candidate packaging verification passes with no changed peer ranges or unintended packed files.
- [x] Readiness report records exact baseline evidence, remote/local commit boundary, version rationale, GitHub/OIDC/npm bootstrap findings, and explicit no-publish status.
- [x] No tag, GitHub Release, npm publication, workflow automation change, credential change, or remote push occurs.

## Notes

Proposed version is `0.2.0`: a broad additive release plus a CLI command
migration; pre-1.0 minor versioning communicates that scope better than a
patch. Publication remains blocked until the release commit is on the intended
remote ref, trusted publisher/OIDC setup is operator-verified, and a maintainer
explicitly approves creating the GitHub Release.

## Outcome

Candidate commit `37f99c7` is conditionally approved by QA. Publication is
blocked pending operator verification of npm trusted publisher/OIDC, selection
and remote availability of the exact release commit, and explicit approval to
create GitHub Release `v0.2.0`.
