---
id: TASK-0091
title: Prepare scoped package for publication
status: todo
depends_on: [TASK-0090]
priority: high
tags: [release, npm, package, cli, extension, tdd]
---

# Prepare scoped package for publication

## Problem
The package is currently named `pi-bebop` and documentation correctly says it is not published. It must become a verifiable public `@carbon-ni/pi-bebop` package without breaking the installed CLI or extension contract.

## Desired outcome
The repository can deterministically produce a minimal, public scoped package that is safe to hand to release automation.

## Acceptance criteria
- [ ] Package identity is `@carbon-ni/pi-bebop`, configured for public publication, and all intentional package-name references and lockfile metadata agree.
- [ ] The installed `pi-bebop` executable name and Pi extension entrypoint remain unchanged.
- [ ] Package verification fails on an unexpected package name, version, file, missing runtime file, or non-executable installed CLI.
- [ ] `npm pack --dry-run` and the packed tarball contain only the intentional runtime, type, license, and documentation allowlist; repository-local plans, `.pi`, `.tmp`, logs, databases, tests, and fixtures are absent.
- [ ] A locked clean consumer can install the local tarball, run CLI help plus one non-mutating command, and load the extension through the supported Pi host.
- [ ] Existing CI and package verification remain registry-free and deterministic.
- [ ] Documentation continues to say the package is unpublished until post-publication verification succeeds.

## Non-goals
- Publishing any package or modifying npm organization settings.
- Providing an unscoped compatibility package.
- Changing CLI commands, extension behavior, or supported Pi peer ranges unless verification exposes an incompatibility.

