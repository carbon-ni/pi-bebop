---
id: TASK-0082
title: List configured crew roles
status: todo
depends_on: []
priority: normal
tags: [crew, cli, roles, discovery, tdd]
---

# List configured crew roles

## Problem
Operators cannot discover valid manifest roles before choosing a member with --crew-role, so startup depends on knowing or opening crew.json manually.

## Context

Expose role discovery as the read-only `pi-bebop crew roles` CLI command. The
requested capability belongs to the standalone Bebop CLI, not Pi extension
startup: `pi --crew-role <role>` selects identity, while discovery must print a
bounded command result and exit without opening a Pi session.

Add the command through the existing `src/cli` registry/parser and a dedicated
handler. Keep manifest parsing and role projection separate: domain code returns
distinct role values in first-manifest-appearance order; infrastructure owns
trusted manifest loading; the CLI handler only composes them into the existing
result/output boundary.

## Acceptance criteria

- [ ] Tests are written first for successful discovery and every failure path.
- [ ] `pi-bebop crew roles` reads the supported crew manifest rooted at the explicit CLI working directory, prints the configured roles, and exits 0 without starting a server, joining a member, or mutating files.
- [ ] Roles are exact, case-sensitive strings, deduplicated in first-manifest-appearance order; an empty member list remains an invalid manifest and fails through existing validation.
- [ ] Default output follows the existing token-efficient TOON result contract; `--format json` returns the same schema and `--full` follows existing common-flag behavior rather than inventing command-specific formatting.
- [ ] Output exposes role values and manifest-level counts only; it does not expose member names, instructions, socket paths, or global session destinations.
- [ ] The pure domain projection is deterministic and independent of filesystem, Pi runtime, and CLI rendering.
- [ ] Existing trusted manifest parsing/path rules are reused; missing, malformed, unsupported-version, unsafe-path, and ambiguous dual-layout manifests fail explicitly through the standard structured error boundary with non-zero exit status.
- [ ] Registry, root help, leaf help, valid-command hints, CLI contract tests, and packaged executable tests include `crew roles`.
- [ ] `extension.ts` gains no `--crew-roles` startup flag; existing `--crew-role`, `--crew-socket`, and session startup behavior remain byte-compatible.
- [ ] README startup guidance shows role discovery immediately before `pi --crew-role <role>`.

## Out of scope

- Member selection, role authorization, online/member status, watching manifest
  changes, interactive prompts, and changing duplicate-role selection behavior.

## Verification

- Run focused domain, registry/parser, handler, help, output, and packaged CLI tests.
- Measure coverage for the new projection and handler, and inspect change impact on
  the command registry and crew-manifest loader.

## Notes

Product decision: prefer `pi-bebop crew roles` over `pi --crew-roles`. Listing is
a finite read-only CLI operation; a Pi extension flag would unnecessarily open a
session and mix discovery with identity selection.

