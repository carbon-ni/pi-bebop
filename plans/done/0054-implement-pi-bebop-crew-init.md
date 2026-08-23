---
id: TASK-0054
title: Implement pi-bebop crew init
status: done
depends_on: [TASK-0053]
priority: normal
tags: [crew, cli, init, scaffold, filesystem, axi, tdd]
---

# Implement pi-bebop crew init

## Problem
Add the standalone pi-bebop crew init command that validates arguments before IO, creates the canonical .pi/bebop scaffold atomically, reports compact structured results, and never silently overwrites user-edited crew configuration.

## Context

Implement TASK-0053 as second standalone CLI branch without weakening current `pi-bebop send` behavior:

```bash
pi-bebop crew init
pi-bebop crew init --project /work/project --format json
pi-bebop crew init --help
```

The common decision after command is: was scaffold created/unchanged, where is manifest, and what should caller run next? Keep default output bounded and machine-readable. With no arguments, return compact TOON discovery showing executable, one-sentence purpose, current-project scaffold state (`missing|present`), available commands, and `crew init` next step when missing; do not dump full help.

## Implementation approach

1. Add failing argument tests and introduce discriminated CLI options for `send` versus `crew init`; validate full command-local flag surface before filesystem IO.
2. Add pure domain scaffold module containing versioned relative paths/content and result/error contracts; generated manifest must parse through current domain parser.
3. Add injected filesystem adapter with preflight, symlink rejection, byte comparison, same-parent private staging, atomic rename, concurrency/no-op reconciliation, and cleanup.
4. Dispatch init before stdin/network setup; reuse one format renderer boundary for TOON/JSON/text without coupling scaffold domain to serializer.
5. Package template/runtime modules and update README quick start to prefer `pi-bebop crew init` while keeping manual setup documented.
6. Validate packed CLI from isolated temp project for created, unchanged, conflict, JSON/TOON/text, and command-local help.

## Acceptance criteria

- [x] Parser accepts exactly `crew init` plus optional `--project <directory>` and `--format toon|json|text`; send parser behavior remains byte-for-byte compatible.
- [x] No arguments exits 0 with compact TOON home state and copyable `crew init` hint when missing; unknown command names valid alternatives (`send`, `crew init`) and exits 2 before mutation/network IO.
- [x] `crew init --help` exits 0 without IO and shows deterministic local help with defaults/files/exits and 2–3 runnable examples.
- [x] Domain scaffold produces exact TASK-0053 managed paths and deterministic content; real parser/loader resolves manifest, contact, descriptions, and all Role instructions.
- [x] Fresh existing project directory creates canonical scaffold atomically and returns `created` with relative paths and next steps.
- [x] Exact rerun returns `unchanged`, performs zero writes/renames, and preserves mtimes/content.
- [x] Any differing managed path, unexpected type, symlink, existing partial layout, unwritable project, or staging/publish failure returns stable code and leaves existing content untouched.
- [x] Concurrent processes leave one complete valid scaffold; loser reconciles to `unchanged` or stable conflict without partial mix.
- [x] Staging directories are permission-safe, bounded to target project `.pi`, and cleaned on every terminal path.
- [x] Command never creates `inbox/`, socket links, processes, session files, Git state, or trust records.
- [x] Default TOON and JSON outputs round-trip to same semantic result; text remains concise; progress/raw stack/dependency errors do not contaminate structured stdout.
- [x] Usage errors exit 2, operational/conflict errors exit 1, created/unchanged/help exit 0.
- [x] Tests cover success, no-op, each conflict class, validation-before-IO, permission/publish failure, cleanup, concurrent race, output formats, escaping, and SIGINT-safe termination.
- [x] Existing direct-send and external-intake CLI integration tests remain green.
- [x] README documents generated files, safe rerun/conflict behavior, editing before join, and manual alternative.
- [x] Package dry-run and isolated packed CLI include/init required templates; coverage/risk analysis and fresh final watcher gate pass.

## Out of scope

- Force overwrite, merge/update, compatibility layout generation, prompts, member customization flags, starting sessions, socket creation beyond empty directory, Inbox initialization, Git edits, or extension installation.

