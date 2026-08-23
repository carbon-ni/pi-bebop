---
id: TASK-0067
title: Deliver member idle-wait CLI
status: todo
depends_on: [TASK-0061]
priority: high
tags: [cli, rpc, idle, subscription, timeout, tdd]
---

# Deliver member idle-wait CLI

## Problem
One-shot member idle waiting remains model-tool-only and needs a dedicated slice for timeout, subscription, disconnect, and cancellation behavior.

## Context

Add:

```text
pi-bebop member wait-idle <member> [--timeout <seconds>]
```

The source joined session performs existing target resolution and wait flow. CLI
waits once for idle, offline, or bounded timeout, then exits; it never polls or
claims the member saw a message or finished work.

## Acceptance criteria

- [ ] Tests first cover already-idle, busy-to-idle, timeout, offline transition, exact-name/unique-role, unknown/ambiguous/self, duplicate subscription, source disconnect, SIGINT, and formats.
- [ ] Timeout units/default/bounds match the tool contract and are validated before connection.
- [ ] Tagged RPC action delegates to existing member-idle-wait flow and target subscription transport.
- [ ] Registration plus initial idle snapshot remains atomic; terminal idle comes only from settled runtime semantics.
- [ ] Client/source/target disconnect and cancellation clean every subscription/listener exactly once.
- [ ] Output distinguishes already-idle, became-idle, offline, timeout, and aborted without interpreting intent or completion.
- [ ] No polling, nondeterministic sleeps, or unbounded waits are introduced.
- [ ] CLI/tool parity and existing idle subscription regression tests pass.
- [ ] Packaged command is verified with deterministic injected scheduler/transport fixtures.

## Out of scope

- Persistent monitoring, automatic follow-up delivery, or waiting on self.
