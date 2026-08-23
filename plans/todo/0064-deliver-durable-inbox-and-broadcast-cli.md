---
id: TASK-0064
title: Deliver durable inbox and broadcast CLI
status: todo
depends_on: [TASK-0061]
priority: high
tags: [cli, rpc, inbox, broadcast, persistence, tdd]
---

# Deliver durable inbox and broadcast CLI

## Problem
Durable one-recipient Inbox delivery and all-other-member broadcast remain model-tool-only despite sharing persistence semantics and storage boundaries.

## Context

Add:

```text
pi-bebop member inbox send <member> [--session <id|alias>] (--message <text> | --stdin)
pi-bebop crew broadcast [--session <id|alias>] (--message <text> | --stdin)
```

Execute inside selected source session so active membership, project trust, and
trusted Inbox stores remain authoritative. Success means persisted, never read,
delivered, or completed. `member inbox send` is effect-bearing and reserves
`member inbox status|pause|resume|cancel` for possible future management.
Implement Inbox and Broadcast as isolated command/action modules and contribute
them through the owned registries.

## Acceptance criteria

- [ ] Tests first cover targeted and broadcast persistence, command-local source selection, message/stdin, instructions, unknown/ambiguous/self target, zero recipients, full/untrusted store, partial broadcast dispositions, cancellation before/after persistence, disconnect, safe retry, and formats.
- [ ] Isolated tagged RPC/action and CLI command modules bound all fields and never accept caller-supplied source identity or manifest path; registry changes are made only by assigned integration owner.
- [ ] Source server delegates to existing Inbox and broadcast application flows/stores without copied persistence rules.
- [ ] Inbox persists exactly one target item; broadcast persists separate idempotent items for every other configured member in manifest order.
- [ ] Results distinguish persisted, skipped, failed, full, and partial-after-cancel outcomes without claiming delivery/completion or rollback.
- [ ] Broadcast id is fixed before recipient writes; cancellation/disconnect after partial persistence preserves completed writes, exposes known dispositions when acknowledgement remains possible, and otherwise returns bounded outcome-unknown/retry guidance.
- [ ] Retrying identical source/content/instructions deterministically reuses broadcast/item identities, reports already-persisted recipients, and never duplicates successful copies.
- [ ] Invalid input fails before stdin/store/socket IO and operational failures use stable bounded codes.
- [ ] CLI/tool parity tests cover happy and unhappy paths for both operations.
- [ ] Existing status, messaging, and public CLI regressions remain green.
- [ ] Packaged commands/help work from isolated trusted and untrusted fixtures.

## Out of scope

- Follow-up delivery, redirect, interrupt, Focus, or idle waiting.
