---
id: TASK-0067
title: Deliver member idle-wait CLI
status: todo
depends_on: [TASK-0061, TASK-0070]
priority: high
tags: [cli, rpc, idle, subscription, timeout, tdd]
---

# Deliver member idle-wait CLI

## Problem
One-shot member idle waiting remains model-tool-only and needs a dedicated slice for timeout, subscription, disconnect, and cancellation behavior.

## Context

Add:

```text
pi-bebop member wait-idle <member> [--session <id|alias>] [--timeout <duration>]
```

The source joined session performs existing target resolution and wait flow. CLI
waits once for idle, offline, or bounded timeout, then exits; it never polls or
claims the member saw a message or finished work.

`--timeout` uses the same positive duration grammar as `send` (`500ms|30s|5m`),
defaults to `5m`, and normalizes to the tool's 1-second through 10-minute bound.
Idle Wait rejects sub-second or non-whole-second durations (for example `500ms`
or `1500ms`) with usage guidance; accepted duration strings must resolve exactly
to 1–600 whole seconds.
A separate fixed 5-second source resolution/connection deadline covers setup,
not the idle operation. The source session owns semantic wait expiry and client
transport permits operation deadline plus bounded 5-second response grace, so a
source `timeout` result wins rather than racing a generic transport timeout.
Implement Idle Wait as isolated command/action modules and contribute it through
the owned registries.

## Acceptance criteria

- [ ] Tests first cover already-idle, busy-to-idle, timeout boundary, setup timeout, response grace, offline transition, exact-name/unique-role, unknown/ambiguous/self, command-local source selection, duplicate subscription, source disconnect, SIGINT, and formats.
- [ ] `--timeout` uses the shared duration parser, defaults to `5m`, accepts only values resolving exactly to 1–600 whole seconds, rejects sub-second/non-whole-second values without rounding, and validates before connection.
- [ ] Fixed 5-second source setup deadline, semantic idle deadline, and 5-second client response grace are distinct; tests prove semantic idle/offline result wins simultaneous setup/operation/transport boundaries.
- [ ] Isolated tagged RPC/action and CLI command modules delegate to existing member-idle-wait flow and target subscription transport; registry changes are made only by assigned integration owner.
- [ ] Registration plus initial idle snapshot remains atomic; terminal idle comes only from settled runtime semantics.
- [ ] Client/source/target disconnect and cancellation clean every subscription/listener exactly once.
- [ ] Output distinguishes already-idle, became-idle, offline, timeout, and aborted without interpreting intent or completion.
- [ ] No polling, nondeterministic sleeps, or unbounded waits are introduced.
- [ ] CLI/tool parity and existing idle subscription regression tests pass.
- [ ] Packaged command is verified with deterministic injected scheduler/transport fixtures.

## Out of scope

- Persistent monitoring, automatic follow-up delivery, or waiting on self.
