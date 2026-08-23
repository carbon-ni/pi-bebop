---
id: TASK-0060
title: Define CLI parity for membership tools
status: todo
depends_on: [TASK-0056]
priority: high
tags: [cli, tools, axi, protocol, product]
---

# Define CLI parity for membership tools

## Problem
Bebop's eight joined-membership capabilities are available only as in-agent tools, forcing shell callers and automation to depend on model tool invocation instead of a deterministic CLI contract.

## Context

Cover exactly the eight membership-scoped tools registered by Bebop:

| Tool | Proposed CLI |
|---|---|
| `send_follow_up` | `member follow-up <member>` |
| `redirect_member` | `member redirect <member>` |
| `send_to_inbox` | `member inbox <member>` |
| `broadcast_to_crew` | `crew broadcast` |
| `interrupt_member` | `member interrupt <member>` |
| `get_member_status` | `member status <member>` |
| `update_member_focus` | `member focus set <text>` / `member focus clear` |
| `wait_for_member_idle` | `member wait-idle <member>` |

Commands execute as one existing joined Pi session, selected explicitly by
`--session <id|alias>` or deterministically from `PI_SESSION_ID` when invoked
inside Pi's Bash environment. Explicit flag wins; missing/unknown/unjoined source
fails before member action IO. Target labels preserve current exact-name then
unique-role semantics.

This task approves names and contracts only. It must not make standalone CLI
code load a manifest and impersonate a member.

## Acceptance criteria

- [ ] One matrix maps every tool input, default, success result, error code, delivery semantics, and cancellation behavior to one non-interactive CLI command.
- [ ] Command names use stable product language and remain grouped under `member` or `crew`; no command collides with existing `send` or `crew init` behavior.
- [ ] Source-session selection contract defines `--session`, `PI_SESSION_ID` fallback, precedence, alias/ID resolution, missing/offline/unjoined errors, and trust assumptions.
- [ ] Message-taking commands consistently support `--message` or `--stdin`, ordered `--instruction` where the tool does, UTF-8 limits, and deterministic empty-input errors.
- [ ] Immediate redirect, normal follow-up, durable inbox, hard interrupt, and broadcast remain separate commands; CLI terminology does not blur their different guarantees.
- [ ] Status/focus/wait commands preserve privacy boundaries, timeout bounds, self-target rejection, ambiguous-role handling, and focus set/clear semantics.
- [ ] All outputs use existing TOON default and JSON/text opt-ins with exit 0/1/2; successful persistence/delivery never overclaims completion.
- [ ] Root/home and local help expose the new commands compactly without dumping all tool documentation.
- [ ] Scope explicitly excludes Pi built-in tools (`read`, `bash`, `edit`, `write`) and covers Bebop membership tools only.

