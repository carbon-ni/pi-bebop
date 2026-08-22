---
id: TASK-0018
title: Remove direct pairing protocol and state
status: done
depends_on: [TASK-0017]
priority: high
tags: [intray, crew, cleanup, domain, protocol]
---

# Remove direct pairing protocol and state

## Problem
Removing pairing commands leaves dead `connect`/`disconnect` RPC messages, peer/listening domain state, and runtime handlers that increase lifecycle complexity without a caller.

## Context
Complete removal of earlier direct-connection feature while retaining request-scoped RPC transport and crew membership state.

## Acceptance criteria
- [x] Tests first characterize surviving status, send, subscribe, clear, abort, and lifecycle behavior.
- [x] RPC `connect` and `disconnect` command types and handlers are removed.
- [x] `ConnectionState`, peer acceptance/disconnect rules, and pairing-only exports/tests are removed.
- [x] `SocketState` no longer contains peer/listening/tool-snapshot fields.
- [x] Status derives base server and crew membership without legacy connected/listening states and refreshes footer on join/restore/leave transitions.
- [x] Session start, reload, replacement, shutdown, and stop contain no peer cleanup calls.
- [x] Request-scoped RPC and global UUID socket lifecycle remain unchanged.
- [x] No production or active configuration/documentation references to removed pairing/listening concepts remain; default startup config is `startByDefault`.
