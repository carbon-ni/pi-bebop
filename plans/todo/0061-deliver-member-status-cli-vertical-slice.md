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

Implement `pi-bebop member status <member> [--session <id|alias>]` as the
walking skeleton plus the approved `pi-bebop session list` discovery surface.
Resolve the source joined Pi session from leaf-command-local explicit flag or
injected `PI_SESSION_ID`, send a schema-validated membership action to that
session, and run the existing member-status application flow there.

The source session is authoritative for membership and trust. CLI never loads a
manifest or accepts claimed source identity.

Before parallel membership slices become ready, establish two additive seams:

- one isolated action module per tag containing schema, result, and source-session handler;
- one owned ordered membership-action registry that constructs the tagged union and dispatch table.

TASK-0061 owns the registry contract and its integration tests. Later slices add
their own action/command modules and one registry contribution; an explicitly
assigned integration owner serializes registry-only edits. They must not copy or
independently widen a central switch/union.

## Acceptance criteria

- [ ] Tests first cover exact-name and unique-role success, configured target offline/unavailable, unknown/ambiguous/self target, missing/unsafe/unknown/offline/unjoined source session, malformed RPC, timeout, cancellation, and all output formats.
- [ ] Leaf-command-local `--session` placement and explicit-over-`PI_SESSION_ID` precedence are deterministic; no/unsafe source fails before member endpoint IO.
- [ ] `session list` discovers only safe reachable ids/aliases and joined state with bounded output, explicit empty state, privacy exclusions, and copyable recovery hint.
- [ ] Protocol schema accepts only the status action and bounded target label in this slice; malformed/oversized input is rejected.
- [ ] Receiving session derives source identity/membership from active runtime and cannot be overridden by request fields.
- [ ] Per-action schema/result/handler module and owned ordered registry are proven by tests; later actions can extend through one registry contribution without editing status handler or a copied central switch.
- [ ] Registry integration ownership and merge protocol are documented before TASK-0062/0064/0065/0066/0067 start in parallel.
- [ ] Server delegates to the same member-status flow/dependencies as the tool, with no copied target/privacy validation.
- [ ] CLI handler only resolves source endpoint, submits RPC, maps result, and renders.
- [ ] Online result includes member, activity, pending-message signal, optional Focus, and observation time needed for next decision.
- [ ] Configured target unreachability returns successful `presence=offline` with unavailable activity/pending/Focus and no stale Focus, distinct from source-session or protocol transport failure.
- [ ] CLI and tool parity tests assert equivalent stable codes and semantic status data.
- [ ] Existing RPC and CLI commands remain compatible; local socket permissions are documented as control boundary.
- [ ] Packaged CLI proves one real end-to-end status query against a joined test session.
