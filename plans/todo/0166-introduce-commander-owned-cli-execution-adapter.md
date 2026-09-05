---
id: TASK-0166
title: Introduce Commander-owned CLI execution adapter
status: doing
depends_on: [TASK-0165]
priority: high
tags: [cli, commander, dispatch, composition, tdd]
---

# Introduce Commander-owned CLI execution adapter

## Problem

Commander schemas exist, but production still performs manual longest-prefix dispatch and rebuilds leaf parsers. A single execution adapter is needed before commands can migrate without breaking rendering, cancellation, or exit behavior.

## Desired outcome

One Commander program is the production entry point for root options, nested command dispatch, and asynchronous actions. It receives injected argv and streams, returns one application outcome, and never lets Commander call `process.exit` or write outside the owned render boundary.

## Acceptance criteria

- [x] TDD baseline recorded: at exact parent `705380d`, `runCli` called `registry.parseCliCommand` directly and bypassed `registry.root()`; the committed adapter tests are green and `runCli` now executes only through the Commander tree.
- [x] Root, groups, leaves, help, and version are registered once through the registry composition hooks and one `createCliExecutionAdapter` composition root.
- [x] Commander dispatches nested commands and awaits asynchronous handlers; production `runCli` no longer calls manual longest-prefix parsing or leaf lookup dispatch.
- [x] Exactly one outcome is rendered through `writeOutcome`; SIGINT is installed/removed once around every adapter execution path, including usage, help, version, and thrown-error paths.
- [x] Injected argv, cwd, stdin, stdout, stderr, environment, and signal seams are carried by `CliExecutionRequest`; Commander output is suppressed into the owned render boundary.
- [x] Unknown command/option and missing/excess argument failures are rejected before leaf handlers/dependencies; exit behavior remains 0/1/2 and packaged parity passes.
- [x] Central `rejectDuplicateScalarOptions` rejects repeated scalar options before parse/handler execution, preserves repeated `--instruction`, and honors `--`.
- [x] Existing leaf parser facades remain characterized migration adapters; no new manual dispatcher was added. Leaf `-h`/`--help` is handled centrally while parser migration remains owned by TASK-0167/0168.
- [x] Packaged direct artifact and installed bin tests execute the same adapter-backed path.

## Constraints

This slice changes ownership, not command output defaults or business semantics. Keep domain and infrastructure out of the Commander adapter.

## Tests

Cover root and three-level nested dispatch, async success/failure, help/version, invalid syntax, no handler call on parse failure, one-write behavior, SIGINT cleanup, and packaged-bin parity.

## Evidence

Implementation commit: `992b335`.

- Adapter characterization suite: 5/5; focused root/registry/CLI suite: 75/75.
- Full test suite: 1208/1208.
- `npm run format:check`, `npm run lint`, and `npm run verify:cli`: pass. Latest CLI gate: 632/632 tests, 90.23% branch coverage.
- Existing packaged/bin parity tests pass, including root/leaf help, version, no-argument home, usage exit 2, and direct artifact execution.
- Commander output is configured to no-op streams; all user-visible output remains one `writeOutcome` call in `runCli`.
