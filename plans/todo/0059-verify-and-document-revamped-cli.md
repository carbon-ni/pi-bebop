---
id: TASK-0059
title: Verify and document revamped CLI
status: doing
depends_on: [TASK-0062, TASK-0064, TASK-0065, TASK-0066, TASK-0067, TASK-0055]
priority: high
tags: [cli, docs, package, axi, verification]
---

# Verify and document revamped CLI

## Problem
The modernized CLI and new membership-tool commands need packaged-binary evidence and complete agent-facing discovery without regressing the existing public command contract.

## Context

Close the compatibility-first refactor and membership-tool parity work with
packaged-binary and agent-experience evidence. Documentation, generated scaffold
hints, home discovery, examples, and tests must share command metadata. This
closes after TASK-0055 so startup examples consistently use approved
role-selection syntax. Remove stale hand-written parser code, not supported
public commands.

## Acceptance criteria

- [ ] README and architecture docs explain existing commands plus the new member/crew action hierarchy, command-local flags, default TOON output, JSON/text opt-ins, exits, stdin, cancellation, source-session selection, and delivery guarantees.
- [ ] Home output and Crew init next commands are generated from shared command metadata and contain copyable current syntax.
- [ ] Root and command-local help cover all flags/defaults and 2–3 runnable examples without dumping unrelated commands.
- [ ] Current `send --socket`, `send --crew`, and `crew init` examples remain valid; stale parser-internal terminology and unsupported proposed renames are absent.
- [ ] Packed CLI tests run home, each command help, direct send, Crew Intake send, Crew init, every membership action, structured usage errors, stdin, timeout, and SIGINT from isolated projects/sessions.
- [ ] TOON and JSON outputs round-trip to the same semantic results; representative output sizes and help/error round trips are recorded without unsupported savings claims.
- [ ] Unknown commands/flags fail before filesystem, stdin, socket, manifest, or inbox dependencies; empty results and no-ops are explicit.
- [ ] Package lock, production dependency classification, license, build bundle, package file list, and consumer fixture are verified.
- [ ] Focused coverage meets the existing risk gate for parser, dispatch, handlers, status, messaging, persistence, interrupt, Focus, idle waiting, output, and packaged entrypoint; no command-critical branch is uncovered.
- [ ] Final complexity/module graph confirms no CLI cycles, thin composition root, and removal of manual parser hotspots.
- [ ] For `src/cli/**` plus new membership RPC/action/handler modules, final coverage is 100% functions, at least 95% lines, and at least 90% branches. Every stable result/error-to-exit mapping, validation-before-IO branch, cancellation cleanup path, and output format has a named test regardless of aggregate coverage.
- [ ] Record UTF-8 byte counts (no ANSI, LF endings) for success, usage error, operational error, empty list, and 100-session truncated-list fixtures in TOON/JSON/text. Any documented size comparison cites these exact fixtures; no format is called smaller unless its measured count is lower for that fixture.
- [ ] Final analysis reports zero CLI module cycles, `runCli` cyclomatic complexity ≤5, and every leaf handler ≤10; exceeding a limit blocks close-out.

## Release note

Publish CLI-library migration as behavior-compatible. Announce membership action
commands as additive. Any future public command renaming requires a separate
major-version decision.

