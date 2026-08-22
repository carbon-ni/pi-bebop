---
id: TASK-0016
title: Remove paired send tool mode
status: done
depends_on: [TASK-0014]
priority: high
tags: [intray, crew, cleanup, tool]
---

# Remove paired send tool mode

## Problem
Once `send_to_member` exists, `send_to_peer` and its exclusive tool activation mode duplicate messaging and hide useful crew tools.

## Context
This is first removal slice for earlier one-peer direct-connection feature. Keep command/protocol cleanup separate so each change remains focused and verifiable.

## Acceptance criteria
- [x] Replacement tests prove `send_to_member` covers happy, unavailable-member, and abort paths before deletion.
- [x] `send_to_peer` implementation, registration, exports, and tests are removed.
- [x] Pairing-specific active-tool snapshot and discovery-tool suppression are removed.
- [x] Joining/leaving crew activates and restores crew tools without changing unrelated extension tools.
- [x] `send_to_session` remains available for explicit session/socket targeting.
- [x] Tool documentation contains no active `send_to_peer` instructions.
