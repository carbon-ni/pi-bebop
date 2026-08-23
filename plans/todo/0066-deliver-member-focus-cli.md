---
id: TASK-0066
title: Deliver member focus CLI
status: todo
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
pi-bebop member focus set <text>
pi-bebop member focus clear
```

The selected source session updates its own Focus through the existing session
entry mechanism. No target member argument is accepted.

## Acceptance criteria

- [ ] Tests first cover set, replace, clear, already-clear no-op, whitespace/empty/oversized/hostile text, missing/offline/unjoined source, malformed RPC, cancellation, and formats.
- [ ] Source membership comes only from active runtime; request cannot choose another member or identity.
- [ ] Tagged RPC action delegates to the same Focus validation/persistence used by `update_member_focus`.
- [ ] Set/clear appends the correct durable session state and immediately changes subsequent member-status snapshots.
- [ ] No-op semantics and result wording are explicit and deterministic.
- [ ] Focus remains self-reported, unverified, single-line, bounded, and must not expose secrets or private context in help/examples.
- [ ] Invalid input fails before session mutation or socket IO where locally decidable.
- [ ] CLI/tool parity tests and status regression tests pass.
- [ ] Packaged set/status/clear/status round trip is verified.

## Out of scope

- Setting another member's Focus or inferring Focus from conversation/activity.
