---
id: TASK-0065
title: Deliver member interrupt CLI
status: todo
depends_on: [TASK-0061]
priority: high
tags: [cli, rpc, interrupt, recovery, cancellation, tdd]
---

# Deliver member interrupt CLI

## Problem
Hard interruption remains model-tool-only and needs an isolated slice because abort and recovery guarantees carry higher risk than normal messaging.

## Context

Add:

```text
pi-bebop member interrupt <member> [--session <id|alias>] (--message <text> | --stdin)
```

The selected source session resolves the configured target and invokes the
existing interrupt flow. Target-owned recovery remains responsible for evidence,
best-effort abort, and priority guidance; CLI cannot roll back completed effects.
Implement Interrupt as isolated command/action modules and contribute it through
the owned registries.

## Acceptance criteria

- [ ] Tests first cover idle/busy target, exact-name/unique-role, unknown/ambiguous/self, command-local source selection, message/stdin, instructions, offline/unjoined source, target rejection, timeout, disconnect, cancellation, and formats.
- [ ] Help and result wording reserve interrupt for stuck/harmful recovery and state best-effort/no-rollback limits.
- [ ] Isolated tagged RPC/action and CLI command modules are bounded and cannot claim source identity or bypass current membership; registry changes are made only by assigned integration owner.
- [ ] Source server delegates to existing member-interrupt resolution and transport; target server keeps existing recovery flow.
- [ ] Interrupt evidence is recorded before abort request and recovery guidance is prioritized according to current contract.
- [ ] Disconnect/cancellation cleans listeners without deleting durable recovery evidence.
- [ ] Output returns interrupt id/disposition or stable bounded error, never target completion.
- [ ] CLI/tool parity and existing interrupt recovery regression tests pass.
- [ ] Packaged command proves busy and idle scenarios deterministically with mocked external timing.
- [ ] An online idle target succeeds with disposition `direct`: persist pending evidence, do not call abort, hand off one immediate recovery turn, then persist handed-off evidence. A busy target has disposition `interrupt-requested` and abort remains best-effort. Offline is an operational error; idle is neither an error nor a no-op.

## Out of scope

- Normal redirect/follow-up or broadcast interruption.
