---
id: TASK-0167
title: Migrate discovery and lifecycle commands to Commander
status: doing
depends_on: [TASK-0166]
priority: normal
tags: [cli, commander, parsing, help, discovery, lifecycle, tdd]
---

# Migrate discovery and lifecycle commands to Commander

## Problem

Low-risk discovery and lifecycle leaves still duplicate option scanning, help, Commander error mapping, and semantic normalization. They should prove the migration pattern before message-heavy commands move.

## Scope

Migrate `crew init`, `crew roles`, `session list`, `member status`, and `member wait-idle`.

## Desired outcome

Each scoped command declares its arguments, options, defaults, descriptions, and examples once through Commander. Parsed values then enter small application-owned semantic validators and unchanged handlers.

## Acceptance criteria

- [x] Commander owns scoped production execution: option tokenization, equals syntax, positional arity, defaults, `-h`/`--help`, unknown options, and missing values are handled by the adapter/tree before migrated readers and handlers.
- [x] Production registry leaves now use Commander readers for all five scoped commands; legacy direct parser facades remain only as characterized compatibility adapters for existing callers and are not on the production execution path.
- [x] Repeated scalar options fail through the central app-owned Commander option hook before the migrated readers/handlers; command-local scanners are not consulted by production execution.
- [x] Duration/range, UTF-8, path, format, session, trust, and target validation remain explicit readers/application/domain rules with no IO during syntax validation.
- [x] Help is generated from the same Commander declarations and the existing safe help presenters; help performs no project/session IO.
- [x] Existing successful command data, side effects, ordering, exit codes, and explicit format behavior remain unchanged in this slice.
- [x] Public CLI/Commander execution and packaged characterization cover the migrated leaves; direct parser facades remain transitional until their dedicated callers are removed.
- [x] Each migrated command has happy, empty, duplicate, unknown, missing, excess, invalid semantic value, help, and dependency-not-called coverage in the existing focused/public suites.

## Non-goals

Communication/request/Guest command migration and output-default changes belong to later tasks.

## Evidence

Implementation commit: `02991f0` at exact starting HEAD `3310965`.

- Production Commander reader path covers `crew init`, `crew roles`, `member status`, `member wait-idle`, and `session list`; communication and Guest leaves were untouched.
- Full test suite: 1208/1208.
- `npm run format:check` and `npm run lint`: pass.
- `npm run verify:cli`: pass, 632/632 tests, 90.06% branch coverage; complexity and package verification pass.
- Focused discovery/lifecycle, adapter, registry, and CLI contract tests pass. Existing packaged/bin tests preserve output, side effects, exit codes, and no-IO-before-usage behavior.
- Transitional parser facades remain for direct compatibility tests; the production adapter selects the Commander `read` hook for each scoped leaf.
