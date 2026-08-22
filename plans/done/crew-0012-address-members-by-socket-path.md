---
id: TASK-0012
title: Address intray members by socket path
status: done
depends_on: [TASK-0007, TASK-0008]
priority: high
tags: [intray, crew, rpc]
---

# Address intray members by socket path

## Problem
Users can only target global session IDs or aliases; selecting a stable repository-local member socket cannot yet identify and reach that running instance.

## Context
Socket path targeting means “communicate with member represented by this endpoint,” not “adopt its role.” Reuse existing request-scoped RPC. Do not extend legacy `/intray connect`; that pairing surface is scheduled for removal.

## Acceptance criteria
- [x] Tests first cover live member socket, stale socket, manifest mismatch, self target, and conflicting target inputs.
- [x] Socket-path targeting does not create or depend on legacy one-peer pairing state.
- [x] `send_to_session` accepts explicit socket path without requiring session ID or global alias.
- [x] Path target is mutually validated when session ID/name is also provided.
- [x] RPC connects through selected endpoint path and keeps existing wait, abort, and reply semantics.
- [x] Existing ID and alias targets remain compatible.
- [x] Error text distinguishes unknown configured member from offline member endpoint.
