---
id: TASK-0066
title: Deliver member focus CLI
status: doing
depends_on: [TASK-0061]
priority: high
tags: [cli, rpc, focus, status, persistence, tdd]
---

# Deliver member focus CLI

## Problem
Members cannot set or clear crew-visible Focus deterministically from shell automation even though Focus is persisted session state and feeds status snapshots.

## Context

Add self-scoped commands:

```text
pi-bebop member focus set [--session <id|alias>] [--] <text>
pi-bebop member focus clear [--session <id|alias>]
```

The selected source session updates its own Focus through the existing session
entry mechanism. No target member argument is accepted. A standard `--`
terminator allows dash-leading text after all command-local flags, for example
`member focus set --session lead -- --blocked`. Implement Focus as isolated
command/action modules and contribute it through the owned registries.

## Acceptance criteria

- [ ] Tests first cover set, replace, clear, already-clear no-op, command-local source selection, whitespace/empty/oversized/hostile text, `-`/`--`-leading text through terminator, missing terminator ambiguity, missing/offline/unjoined source, malformed RPC, cancellation, and formats.
- [ ] Source membership comes only from active runtime; request cannot choose another member or identity.
- [ ] Isolated tagged RPC/action and CLI command modules delegate to the same Focus validation/persistence used by `update_member_focus`; registry changes are made only by assigned integration owner.
- [ ] Set/clear appends the correct durable session state and immediately changes subsequent member-status snapshots.
- [ ] No-op semantics and result wording are explicit and deterministic.
- [ ] Focus remains self-reported, unverified, single-line, bounded, and must not expose secrets or private context in help/examples.
- [ ] Flags must precede `--`; text after it is preserved verbatim (including leading dashes), while invalid/empty/oversized input fails before source socket IO or session mutation where locally decidable.
- [ ] CLI/tool parity tests and status regression tests pass.
- [ ] Packaged set/status/clear/status round trip is verified.

## Out of scope

- Setting another member's Focus or inferring Focus from conversation/activity.
