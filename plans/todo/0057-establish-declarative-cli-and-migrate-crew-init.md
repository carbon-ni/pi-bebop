---
id: TASK-0057
title: Establish declarative CLI and migrate crew init
status: todo
depends_on: [TASK-0056]
priority: high
tags: [cli, parser, axi, tdd, commands]
---

# Establish declarative CLI and migrate crew init

## Problem
Adding commands and flags currently requires extending manual token loops, but replacing every command at once would delay feedback and hide library integration problems.

## Context

Install the selected library behind an injected parser/output facade. Define the
root, no-argument home, help policy, and `crew init` as the first leaf. Keep
existing `send` temporarily delegated to its characterized parser; TASK-0058
removes that adapter immediately after this slice.

Suggested boundary:

```text
src/cli/commands/root.ts
src/cli/commands/crew-init.ts
src/cli/parser.ts
```

The library owns tokenization/help only. Crew init semantic validation, flow,
filesystem adapter, rendering, and exit codes remain outside it.

## Acceptance criteria

- [ ] Tests first cover home, Crew init defaults/project/format/help, unknown/duplicate/missing flags, `--flag=value`, `--`, invalid format, and validation-before-IO.
- [ ] Selected library is pinned as a production dependency and invoked through injected argv/output without `process.exit` or ambient console writes.
- [ ] No-argument home schema and TOON bytes remain semantically compatible.
- [ ] `crew init` created/unchanged/conflict behavior, exact path resolution, output formats, and exits 0/1/2 remain compatible.
- [ ] Approved root/help behavior is deterministic and performs zero project/application IO.
- [ ] Existing `send` still executes through one explicitly temporary compatibility adapter with its characterization suite unchanged.
- [ ] Crew init hand-written token parsing is removed; there is one declarative flag/help definition.
- [ ] Packaged CLI smoke tests prove home and Crew init work with the bundled dependency before send migration starts.

## Out of scope

- Migrating `send`, decomposing `main.ts`, or adding membership commands.
