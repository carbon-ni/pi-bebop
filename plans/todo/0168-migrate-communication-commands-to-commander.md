---
id: TASK-0168
title: Migrate communication commands to Commander
status: todo
depends_on: [TASK-0167]
priority: high
tags: [cli, commander, messaging, member-request, guest, parsing, tdd]
---

# Migrate communication commands to Commander

## Problem

Message, request, and Guest communication leaves still rely on custom argv pre-passes and duplicated parsing facades. Commander cannot become the only CLI grammar owner until these high-value agent commands migrate with their domain rules preserved.

## Scope

Migrate `send`; `member follow-up`; `member redirect`; `member request send/list/wait/respond`; `member interrupt`; `member inbox send`; `crew broadcast`; and `guest join/leave/send/broadcast`.

## Desired outcome

All CLI grammar is declared through the production Commander tree. Communication-specific validation remains independent, explicit, testable, and unchanged at the domain/application boundary.

## Acceptance criteria

- [ ] Commander owns all scoped command dispatch, arguments, options, defaults, repeatable collection, help, and syntax failures.
- [ ] Ordered repeatable instructions retain their limit; all scalar duplicates fail before message input, filesystem, socket, or RPC dependencies run.
- [ ] Message/stdin XOR, target selection, duration ordering/ranges, guest identity/capability, callback, source session, path, UTF-8, NUL, and trust rules remain application/domain-owned.
- [ ] Legacy `--flag -- --value` inputs fail with a targeted `--flag=--value` migration hint; standard Commander `--` end-of-options behavior is characterized.
- [ ] Delivery mode, wait behavior, request correlation, response timing, guest routing, payload bytes, instruction order, and protocol commands are unchanged.
- [ ] Generated leaf help contains required arguments, defaults, constraints, and 2–3 runnable examples without duplicating option declarations.
- [ ] Before cleanup, exported functions and semantic rules in `src/cli/parser.ts` and `src/cli/flag-scanner.ts` are inventoried with semantic reference checks. Reusable duration/send validation moves to focused modules or remains under an accurate name; compatibility exports stay until all callers migrate.
- [ ] `src/cli/parser.ts`, `src/cli/flag-scanner.ts`, manual registry dispatch, local tokenize/parser pre-passes, and obsolete parser-only tests are deleted only when reference search and typecheck prove no callers. A file remains if it still owns referenced semantic behavior.
- [ ] No production CLI source implements an argv-index loop or imports `CommanderError` outside the central Commander boundary.
- [ ] Full CLI contract, packed artifact, complexity, and tool/CLI parity gates pass.

## Non-goals

Changing default serialization or redesigning response data belongs to TASK-0169 and TASK-0170.
