---
id: TASK-0002
title: Implement connection handshake runtime
status: done
depends_on: [TASK-0001]
priority: high
tags: [intray, runtime, rpc]
---

# Implement connection handshake runtime

## Problem
Both sessions need reciprocal peer identity using existing request-scoped RPC, with clear failure and cleanup semantics.

## Context
Reuse `sendRpcCommand` and current public session sockets. Store reciprocal peer identity in runtime state; do not retain a duplex socket.

## Acceptance criteria
- [x] Outbound connect resolves safe session id/alias and auto-starts caller endpoint without enabling blanket listening.
- [x] Inbound connect succeeds only while listening or for idempotent same-peer retry; failures leave state unchanged.
- [x] Both endpoints cache reciprocal peer identity after successful handshake.
- [x] Disconnect clears matching peers on both ends best-effort and always completes local cleanup.
- [x] Status and transport operations are bounded and AbortSignal-aware.
- [x] Session shutdown/reload/replacement clears pairing without stale context, socket, or timer leaks.
- [x] Temporary Unix-socket tests cover handshake success and unhappy paths.

## Notes

