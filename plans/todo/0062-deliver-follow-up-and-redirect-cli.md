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
pi-bebop member follow-up <member> (--message <text> | --stdin)
pi-bebop member redirect <member> (--message <text> | --stdin)
```

They share message/instruction parsing and application coordinator, but preserve
distinct delivery intent and user-facing guarantees.

## Acceptance criteria

- [ ] Tests first cover both delivery intents, exact-name/unique-role targets, unknown/ambiguous/self targets, message/stdin, ordered instructions, unjoined/offline source, remote rejection, timeout, cancellation, and output formats.
- [ ] Follow-up waits behind active work; redirect enters before the target's next model step; neither description overclaims interruption or completion.
- [ ] One tagged RPC action contract carries bounded member, message, instructions, and delivery intent without claimed source identity.
- [ ] Source server delegates both paths to the existing member-message coordinator and injected transport.
- [ ] Unknown flags/invalid messages fail before stdin or socket IO.
- [ ] CLI outputs preserve delivery disposition and stable semantic errors across TOON/JSON/text.
- [ ] Tool-versus-CLI parity tests prove equivalent inputs and outcomes for both tools.
- [ ] Existing status and public CLI regressions remain green.
- [ ] Packaged help and commands are runnable and bounded.

## Out of scope

- Durable Inbox, broadcast, hard interrupt, Focus, or idle waiting.
