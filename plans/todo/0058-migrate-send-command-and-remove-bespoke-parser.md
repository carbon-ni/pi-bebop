---
id: TASK-0058
title: Migrate send command and remove bespoke parser
status: todo
depends_on: [TASK-0057]
priority: high
tags: [cli, parser, send, compatibility, tdd]
---

# Migrate send command and remove bespoke parser

## Problem
After the first declarative leaf, the highest-complexity manual parser still owns the public `send` command and duplicates framework flag/help behavior.

## Context

Move existing `send` grammar into one declarative definition while preserving
`send --socket` direct delivery and `send --crew` durable Intake. Keep execution
in its current adapter for this slice; TASK-0063 decomposes runtime concerns.

## Acceptance criteria

- [ ] Tests first preserve direct and Crew targets, defaults, paths, message/stdin exclusivity, repeated instructions and cap, origin validation, enums, durations, `--flag=value`, `--`, duplicates, unknown flags, and incompatible Crew transport flags.
- [ ] `send --socket` and `send --crew` return the same typed `SendCliOptions` semantic values as the characterized parser.
- [ ] Target-specific semantic validation finishes before stdin, filesystem, manifest, inbox, or socket IO.
- [ ] Library parse failures map to bounded structured usage results and exit 2 without raw library errors or process exit.
- [ ] Usage-error format selection handles separated and equals syntax according to TASK-0056's explicit decision.
- [ ] Send help is generated from its command metadata and reflects defaults plus runnable direct/Intake examples.
- [ ] Temporary compatibility adapter and manual parsing loops are deleted; `src/cli/arguments.ts` is removed or reduced to types/domain validators only.
- [ ] Complexity analysis shows the 51/22 parser hotspots eliminated.
- [ ] Focused and packaged tests prove current send behavior remains compatible.

## Out of scope

- Splitting execution adapters or adding membership-action commands.
