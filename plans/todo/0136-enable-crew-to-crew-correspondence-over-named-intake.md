---
id: TASK-0136
title: Add a crew-to-crew send tool with return-address convention
status: todo
depends_on: []
priority: high
tags: [crew, messaging, intake, tools, cross-project, tdd]
---

## Problem

A joined member of one crew cannot ask another crew (another project) a question: no tool addresses a foreign crew manifest, and nothing carries a return address, so the other crew cannot answer.

## Approach

Tool `send_to_crew` for joined members:
- Params: `manifestPath` (absolute, target crew.json), `message`, optional ordered `instructions`.
- Embeds claimed origin from the sender's joined membership: crew label (TASK-0133, optional) + return manifest absolute path.
- Delivery: existing durable one-way external-intake path (offline-safe, no live coupling). Ack is persisted-only.
- Reply convention: the received message surfaces the return path; the responder answers with the same tool aimed at it. Letter-style referencing for multi-turn; no thread IDs.

## Acceptance

- Happy: member of crew A sends → lands in crew B intake contact's inbox with claimed origin + return path; B replies the same way; both crews can be offline.
- Unhappy: unjoined sender rejected (no origin to claim); invalid/unreadable target manifest, missing intake contact (external-intake-disabled parity), full inbox — distinct stable errors.
- Trust: origin is attribution only; spoofed return path stored as claimed, never trusted.
- Unjoined scratch agents keep using the CLI `send --crew <path>`; the tool requires membership.
- Deterministic tests, happy and unhappy paths.
