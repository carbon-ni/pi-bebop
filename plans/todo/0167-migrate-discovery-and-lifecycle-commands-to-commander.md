---
id: TASK-0167
title: Migrate discovery and lifecycle commands to Commander
status: todo
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

- [ ] Commander alone owns scoped command option tokenization, equals syntax, positional arity, defaults, `-h`/`--help`, unknown options, and missing values.
- [ ] Scoped manual argv loops, scanner calls, valid-flag strings, handcrafted help duplication, and leaf-local `CommanderError` mappers are removed.
- [ ] Repeated scalar options fail deterministically through the central app-owned Commander option hook/policy rather than Commander's default last-value-wins behavior or command-local argv scanning.
- [ ] Duration/range, UTF-8, path, format, session, trust, and target validation remain explicit application/domain rules with no IO during syntax validation.
- [ ] Help is generated from the same declarations used to parse, includes defaults and 2–3 runnable examples, and performs no project/session IO.
- [ ] Existing successful command data, side effects, ordering, exit codes, and explicit format behavior remain unchanged in this slice.
- [ ] Direct parser tests are replaced by public CLI/Commander action characterization where they no longer represent a public boundary.
- [ ] Each migrated command covers happy, empty, duplicate, unknown, missing, excess, invalid semantic value, help, and dependency-not-called paths.

## Non-goals

Communication/request/Guest command migration and output-default changes belong to later tasks.
