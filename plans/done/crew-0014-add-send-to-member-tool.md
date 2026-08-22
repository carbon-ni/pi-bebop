---
id: TASK-0014
title: Add member-aware crew messaging tool
status: done
depends_on: [TASK-0009, TASK-0012, TASK-0013]
priority: high
tags: [intray, crew, tool]
---

# Add member-aware crew messaging tool

## Problem
An orchestrator joined to a crew needs to address several stable roles without global discovery, UUIDs, or one-peer persistent connections.

## Context
Add request-scoped `send_to_member` over configured member endpoints. One-peer `send_to_peer` remains a separate compact pairing mode.

## Acceptance criteria
- [x] Tests cover successful send, unknown/ambiguous member, offline member, self-send, unjoined caller, distinct abort handling, and synchronous/asynchronous response paths.
- [x] Tool parameters require `member` and `message`, with existing mode/wait policy reused rather than duplicated.
- [x] Member resolves only through current trusted crew manifest.
- [x] Tool uses request-scoped RPC and does not add persistent sockets or multi-peer connection state.
- [x] Tool becomes active only while crew membership is active and restores unrelated tool activation exactly.
- [x] Result and target-specific errors identify the destination member role and preserve bounded output/error behavior.
- [x] Existing one-peer pairing activation and stale-peer cleanup remain deterministic.
