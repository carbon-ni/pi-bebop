---
id: TASK-0166
title: Introduce Commander-owned CLI execution adapter
status: todo
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

- [ ] TDD evidence records a temporary RED host-level characterization showing current production dispatch bypasses the built Commander tree; the committed final test is green and proves Commander dispatch is the production path.
- [ ] Root, groups, leaves, help, and version are registered once in one composition root.
- [ ] Commander dispatches nested commands and awaits asynchronous handlers; manual longest-prefix matching is no longer the production path.
- [ ] Exactly one outcome is rendered and SIGINT is installed/removed once on success, usage failure, operational failure, help, version, and thrown-error paths.
- [ ] Injected argv, cwd, stdin, stdout, stderr, environment, and signal seams keep tests deterministic and prevent ambient IO/process exit.
- [ ] Unknown command/option and missing/excess argument failures reach the existing exit-code and safe-error boundary before handlers or dependencies run.
- [ ] One central app-owned Commander option hook/policy rejects repeated scalar options because Commander is last-value-wins by default; its test proves rejection occurs before handlers and dependencies.
- [ ] Existing leaf parser facades may remain temporarily only as characterized migration adapters; no new command may add another manual dispatcher.
- [ ] Packaged direct artifact and installed bin execute the same Commander path.

## Constraints

This slice changes ownership, not command output defaults or business semantics. Keep domain and infrastructure out of the Commander adapter.

## Tests

Cover root and three-level nested dispatch, async success/failure, help/version, invalid syntax, no handler call on parse failure, one-write behavior, SIGINT cleanup, and packaged-bin parity.
