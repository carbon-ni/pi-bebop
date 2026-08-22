---
id: TASK-0008
title: Claim and release a local crew member endpoint
status: done
depends_on: [TASK-0007]
priority: high
tags: [intray, crew, infra, socket]
---

# Claim and release a local crew member endpoint

## Problem
A crew member needs a stable selectable `.pi/intray/sockets/<member>.sock` endpoint while current server still binds to a short global UUID socket.

## Context
Publish local endpoint as symlink to existing global socket to avoid Unix-domain socket path-length limits. Ownership and stale recovery must be deterministic.

## Acceptance criteria
- [x] Tests first use temporary directories and real Unix sockets for live, stale, missing, and foreign endpoint paths.
- [x] Claim creates parent directories and publishes local symlink to current global socket.
- [x] Claiming same endpoint for same session is idempotent.
- [x] Live endpoint owned by another session is rejected without modification.
- [x] Stale endpoint is replaced safely; concurrent reclaim has one winner and one explicit failure.
- [x] Release removes endpoint only when it still points to current session socket, including concurrent claim/replacement.
- [x] Endpoint publication and cleanup remain infra concerns with injected filesystem/socket seams.
