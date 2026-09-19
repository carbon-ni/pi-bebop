---
id: TASK-0212
title: Rename the CLI command to bebop
status: done
depends_on: [TASK-0209, TASK-0210]
priority: high
tags: [cli, naming, package, docs, breaking-change]
---

# Rename the CLI command to bebop

## Problem

The executable is named `pi-bebop`, although the product is already called Bebop and every command is used in a Pi context. The prefix makes commands longer without adding useful distinction.

## Desired outcome

People invoke the installed CLI as `bebop`, and every copyable command, generated help line, recovery hint, and version line consistently uses that name.

## Product decisions

- Keep the npm package and repository name `@carbon-ni/pi-bebop`; only rename the executable and CLI vocabulary.
- Publish one canonical binary named `bebop`.
- Remove the `pi-bebop` binary alias. This is a deliberate v0 breaking change; do not add a compatibility shim or deprecation path.
- Keep internal identifiers that are not user-facing CLI vocabulary, such as package paths, temporary-directory prefixes, extension status keys, and repository URLs.

## Acceptance criteria

- [ ] `package.json` exposes `bebop` at `./dist/cli/main.js` and no `pi-bebop` binary.
- [ ] Running `bebop`, `bebop --help`, group help, leaf help, usage errors, operational guidance, and `--version` consistently say `bebop`.
- [ ] `npx @carbon-ni/pi-bebop --help` remains valid because the package has one executable.
- [ ] Crew initialization output, next-command hints, source-session recovery, request guidance, and CLI parity fixtures use copyable `bebop ...` commands.
- [ ] README and CLI/user workflow documentation use `bebop ...`; package installation and repository references remain `@carbon-ni/pi-bebop` and `carbon-ni/pi-bebop`.
- [ ] Package verification installs and executes `node_modules/.bin/bebop` and rejects accidental reliance on `.bin/pi-bebop`.
- [ ] Tests assert the canonical name at registry, process, packaged-binary, version, output, recovery-hint, and documentation boundaries.
- [ ] No compatibility alias, migration warning, command pre-parser, or extra executable is introduced.
- [ ] Focused tests, package verification, and final quality gate pass.

## Non-goals

Renaming the npm package, GitHub repository, extension ID/status key, socket/control paths, tarball name, temporary-directory prefixes, or TypeScript module names.
