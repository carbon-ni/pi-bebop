---
id: TASK-0074
title: Make installed pi-bebop executable and help work
status: done
depends_on: []
priority: high
tags: [cli, packaging, entrypoint, help, regression, tdd]
---

# Make installed pi-bebop executable and help work

## Problem

`npm link` correctly creates `.../bin/pi-bebop -> .../dist/cli/main.js`, but
`isCliEntrypoint` requires `process.argv[1]` itself to end with
`/dist/cli/main.js`. Node preserves invoked symlink path, guard returns false,
and installed command exits 0 with empty stdout/stderr without executing any
CLI behavior. Current package verification invokes artifact through `node`, so
it misses broken installed-bin path. User also naturally invokes `pi-bebop -h`,
but root short/long help is not a useful discovery path.

## Acceptance criteria

- [ ] Tests first install/link packed package into isolated prefix and reproduce `node_modules/.bin/pi-bebop` exiting 0 with empty output before fix.
- [ ] Entrypoint detection resolves/canonicalizes invoked executable and module path safely so npm global/local bin symlinks execute, while importing `src/cli/main.ts` in tests/library use never starts CLI.
- [ ] Installed-bin no-argument invocation returns compact TOON home and exit 0.
- [ ] Installed-bin real command (`crew init --help` and one non-mutating leaf) matches direct artifact stdout/stderr/exit semantics.
- [ ] Root `pi-bebop --help` and `pi-bebop -h` return deterministic concise root help on stdout with exit 0; no dependency, project, session, or filesystem IO is performed.
- [ ] Leaf `--help` behavior remains compatible; decide and test leaf `-h` consistently rather than silently accepting only some commands.
- [ ] Unknown commands/flags still produce structured usage output and exit 2; no empty successful response is possible for nonempty argv.
- [ ] Packaged verification executes generated bin shim/symlink directly instead of only `node dist/cli/main.js`, preventing recurrence.
- [ ] Windows path normalization/shim behavior remains explicitly covered or documented by supported-platform contract; no basename-only check that could run imported module accidentally.
- [ ] README installation section states current local install commands and uses verified help invocation.
- [ ] Focused CLI/package tests, coverage, and fresh watcher final gate pass.

## Out of scope

- Publishing npm package, changing command semantics, adding correlated Member
  request CLI, or redesigning structured output formats.
