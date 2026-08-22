---
id: TASK-0004
title: Add compact send_to_peer tool
status: done
depends_on: [TASK-0002]
priority: high
tags: [intray, tools, tokens]
---

# Add compact send_to_peer tool

## Problem
Connected agents should communicate with one minimal tool call and no discovery, target, response-policy, or reverse metadata overhead.

## Context
Primary product outcome: after pairing, outbound communication requires one compact tool call and no skill/list/target-selection flow.

## Acceptance criteria
- [x] `send_to_peer` accepts only `message` plus optional `mode` and routes through cached peer.
- [x] Delivery always uses non-blocking `message_processed` semantics.
- [x] Outgoing message contains no `<sender_info>` or `<reply_instruction>` metadata.
- [x] Disconnected calls fail before RPC; transport failure clears stale pairing promptly.
- [x] Tool propagates Pi AbortSignal without clearing a healthy peer on local cancellation.
- [x] Pairing activates `send_to_peer` and deactivates only intray-owned `send_to_session`/`list_sessions`; disconnect restores prior intray activation without changing unrelated tools.
- [x] Tests assert zero discovery calls, zero target input, compact schema, and happy/unhappy transport paths.

## Notes

