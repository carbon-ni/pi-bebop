---
id: TASK-0061
title: Deliver member status CLI vertical slice
status: todo
depends_on: [TASK-0060, TASK-0063]
priority: high
tags: [cli, rpc, status, membership, security, tdd]
---

# Deliver member status CLI vertical slice

## Problem
The plan needs one low-risk end-to-end membership command to prove source-session selection, authoritative joined identity, RPC delegation, and structured CLI output before mutation commands are added.

## Context

Implement `pi-bebop member status <member>` as the walking skeleton. Resolve the
source joined Pi session from explicit `--session <id|alias>` or injected
`PI_SESSION_ID`, send a schema-validated membership action to that session, and
run the existing member-status application flow there.

The source session is authoritative for membership and trust. CLI never loads a
manifest or accepts claimed source identity. Design protocol envelope to extend
with later tagged actions, but implement status only in this task.

## Acceptance criteria

- [ ] Tests first cover exact-name and unique-role success, unknown/ambiguous/self target, missing/unknown/offline/unjoined source session, malformed RPC, timeout, cancellation, and all output formats.
- [ ] `--session` precedence over `PI_SESSION_ID` is deterministic; no source fails before member endpoint IO.
- [ ] Protocol schema accepts only the status action and bounded target label in this slice; malformed/oversized input is rejected.
- [ ] Receiving session derives source identity/membership from active runtime and cannot be overridden by request fields.
- [ ] Server delegates to the same member-status flow/dependencies as the tool, with no copied target/privacy validation.
- [ ] CLI handler only resolves source endpoint, submits RPC, maps result, and renders.
- [ ] Result includes member, activity, pending-message signal, optional Focus, and observation time needed for next decision.
- [ ] CLI and tool parity tests assert equivalent stable codes and semantic status data.
- [ ] Existing RPC and CLI commands remain compatible; local socket permissions are documented as control boundary.
- [ ] Packaged CLI proves one real end-to-end status query against a joined test session.
