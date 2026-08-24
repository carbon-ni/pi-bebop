---
id: TASK-0060
title: Define CLI parity for membership tools
status: done
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
| `send_to_inbox` | `member inbox send <member>` |
| `broadcast_to_crew` | `crew broadcast` |
| `interrupt_member` | `member interrupt <member>` |
| `get_member_status` | `member status <member>` |
| `update_member_focus` | `member focus set <text>` / `member focus clear` |
| `wait_for_member_idle` | `member wait-idle <member>` |

Commands execute as one existing joined Pi session. `--session <id|alias>` is a
leaf-command-local flag: accepted after the selected leaf command and before any
`--` positional terminator, never as a root or group-global flag. A nonblank
explicit flag wins over `PI_SESSION_ID`; the environment fallback accepts only a
safe exact session id. Missing/unsafe/unknown/offline/unjoined source fails before
member action IO. Target labels preserve current exact-name then unique-role
semantics.

Add `session list` as the bounded discovery surface for shell callers without
`PI_SESSION_ID`. It reports reachable session id, safe aliases, and joined state
only—never messages, prompts, model details, paths, instructions, or tool history.
Empty output is explicit and includes the next step for starting/joining Pi.

Follow-up and Redirect are accepted-delivery commands only. They expose no
`wait_for` flag because delivery-level response correlation is unsupported;
help and unknown-flag errors must say so rather than imply a reply guarantee.

`member wait-idle --timeout` reuses the existing positive duration grammar
(`500ms|30s|5m`) and defaults to `5m`; it accepts only values resolving exactly
to 1–600 whole seconds and rejects sub-second/non-whole-second values without
rounding. A separate fixed bounded connection/setup deadline is not the idle
operation deadline. Source owns the semantic idle timeout; client transport must
allow that deadline plus bounded response grace so semantic `timeout` wins the
boundary race.

Focus remains positional. Flags, including command-local `--session`, precede a
standard `--` terminator when Focus begins with `-`, for example
`member focus set --session lead -- --blocked`.

This task approves names and contracts only. It must not make standalone CLI
code load a manifest and impersonate a member.

## Acceptance criteria

- [x] One matrix maps every tool input, default, success result, error code, delivery semantics, and cancellation behavior to one non-interactive CLI command.
- [x] Command names use stable product language and remain grouped under `member` or `crew`; no command collides with existing `send` or `crew init` behavior.
- [x] Source-session selection contract fixes command-local `--session` placement, explicit-over-environment precedence, safe ID/alias validation, alias/ID resolution, missing/offline/unjoined errors, local-socket trust assumptions, and copyable recovery hints.
- [x] `session list` provides deterministic bounded source discovery with explicit empty state and privacy exclusions; missing/unknown-session errors point to it.
- [x] Message-taking commands consistently support `--message` or `--stdin`, ordered `--instruction` where the tool does, UTF-8 limits, and deterministic empty-input errors.
- [x] Immediate redirect, normal follow-up, durable inbox, hard interrupt, and broadcast remain separate commands; CLI terminology does not blur their different guarantees.
- [x] Follow-up/Redirect deliberately expose accepted-delivery only; CLI has no `wait_for` flag and explicitly states response correlation is unsupported.
- [x] Status/focus/wait commands preserve privacy boundaries, target-offline status semantics, self-target rejection, ambiguous-role handling, Focus set/clear semantics, and dash-leading Focus through `--`.
- [x] `--timeout` has one duration grammar across commands; idle wait separately defines connection/setup deadline, semantic operation deadline, response grace, and terminal precedence.
- [x] All outputs use existing TOON default and JSON/text opt-ins with exit 0/1/2; successful persistence/delivery never overclaims completion.
- [x] Inbox send syntax is effect-bearing (`member inbox send`) and reserves `member inbox status|pause|resume|cancel` for possible future local Inbox management.
- [x] Root/home and local help expose the new commands plus session discovery compactly without dumping all tool documentation.
- [x] Scope explicitly excludes Pi built-in tools (`read`, `bash`, `edit`, `write`) and covers Bebop membership tools only.

## Decision artifacts

- Human contract and rationale: `docs/CLI-MEMBERSHIP-PARITY.md`.
- Normative machine-readable matrix: `docs/cli-membership-parity.json`.
- Deterministic completeness/current-tool-schema guard: `src/cli/membership-parity-contract.test.ts`.

TASK-0060 changes no standalone CLI membership parser, RPC action, handler, or runtime behavior. TASK-0061 owns the first vertical slice.

## Closure requirements (product review)

Before moving this task to done, Markdown and JSON must agree on: closed cancellation/error/result/exit/recovery shapes for Follow-up, Redirect, Interrupt, and each Broadcast recipient; discriminated Focus and Idle result shapes; Broadcast idempotency scope and `idempotency-conflict`; validation-before-stdin versus bounded stdin-content validation; session-list ordering, scan-cap `omitted` count, and bounded/classified alias privacy; and aggregate payload, trim, and NUL rules. The guard must assert enums, defaults, limits, and stable application error codes—not only tool/property names. Run the strengthened focused contract test plus a fresh final gate.

