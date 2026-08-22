---
id: TASK-0019
title: Remove per-message reply instruction disclaimer
status: done
depends_on: []
priority: high
tags: [intray, messaging, cleanup, ux]
---

# Remove per-message reply instruction disclaimer

## Problem
Callback-enabled messages repeat a verbose `<reply_instruction>` block on every delivery, leaking transport guidance into conversation content and UI even though tool guidance already defines reply behavior.

## Context
Keep machine-readable `<sender_info>` so recipient can identify callback target. Remove repeated instruction text from newly sent messages and hide legacy instruction blocks when rendering existing session history.

## Acceptance criteria
- [x] Tests first prove callback-enabled messages contain sender metadata but no `<reply_instruction>` block.
- [x] Domain helper is renamed from instruction-oriented naming to sender-metadata naming.
- [x] Missing/invalid sender identity leaves original message unchanged.
- [x] `send_to_session` with `reply_behavior=allow_reply` replaces closed, duplicate, spoofed, and unclosed metadata markup and emits exactly one authoritative `<sender_info>` block.
- [x] `reply_behavior=end_conversation` and synchronous response policy remain unchanged.
- [x] Message renderer strips both `<sender_info>` and historical `<reply_instruction>` blocks from displayed content.
- [x] Sender name/id header rendering remains unchanged.
- [x] Tool description carries concise callback guidance once instead of embedding it in every message.
- [x] Tests cover malformed and legacy metadata without hiding ordinary user-authored text.
