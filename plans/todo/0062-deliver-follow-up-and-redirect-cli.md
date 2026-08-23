---
id: TASK-0062
title: Deliver follow-up and redirect CLI
status: todo
depends_on: [TASK-0061]
priority: high
tags: [cli, rpc, messaging, delivery, tdd]
---

# Deliver follow-up and redirect CLI

## Problem
Normal queued coordination and immediate redirection remain model-tool-only despite sharing the member-message coordinator and most input validation.

## Context

Add two explicit vertical slices on the TASK-0061 source-session transport:

```text
pi-bebop member follow-up <member> [--session <id|alias>] (--message <text> | --stdin)
pi-bebop member redirect <member> [--session <id|alias>] (--message <text> | --stdin)
```

They share message/instruction parsing and application coordinator, but preserve
distinct delivery intent and user-facing guarantees. Both are accepted-delivery
commands. They intentionally expose no `wait_for` flag: delivery-level response
correlation remains unsupported and must not be approximated from turn/idle
events. Implement each as isolated command/action modules and contribute tags
through the TASK-0061 owned registry.

## Acceptance criteria

- [ ] Tests first cover both delivery intents, exact-name/unique-role targets, unknown/ambiguous/self targets, leaf-command-local session selection, message/stdin, ordered instructions, unjoined/offline source, remote rejection, timeout, cancellation, and output formats.
- [ ] Follow-up waits behind active work; redirect enters before the target's next model step; neither description overclaims interruption, reply, or completion.
- [ ] No `wait_for` CLI flag is accepted; local help and unknown-flag recovery explicitly state accepted delivery is the only acknowledgement and response correlation is unsupported.
- [ ] Isolated tagged action/command modules carry bounded member, message, instructions, and delivery intent without claimed source identity; only the assigned integration owner adds their contributions to TASK-0061/TASK-0063 registries.
- [ ] Source server delegates both paths to the existing member-message coordinator and injected transport.
- [ ] Unknown flags/invalid messages fail before stdin or socket IO.
- [ ] CLI outputs preserve delivery disposition and stable semantic errors across TOON/JSON/text.
- [ ] Tool-versus-CLI parity tests prove equivalent inputs and outcomes for both tools.
- [ ] Existing status and public CLI regressions remain green.
- [ ] Packaged help and commands are runnable and bounded.

## Out of scope

- Durable Inbox, broadcast, hard interrupt, Focus, or idle waiting.
