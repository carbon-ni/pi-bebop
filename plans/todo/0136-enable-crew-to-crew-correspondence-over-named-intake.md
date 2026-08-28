---
id: TASK-0136
title: Add a crew-to-crew send tool with return-address convention
status: todo
depends_on: []
priority: high
tags: [crew, messaging, intake, tools, cross-project, tdd]
---

## Problem

A joined Member of one Crew cannot ask another local-project Crew a question through an agent tool. The existing `send --crew <manifest-path>` CLI persists one-way external intake, but it labels the sender only as external and carries no structured Crew Return Address, so the receiving Crew cannot reliably answer.

## Product contract

`send_to_crew` sends one durable Crew Correspondence to the `intake.contact` selected by an absolute target Crew Manifest path.

- Input: absolute `manifestPath`, non-empty `message`, optional ordered `instructions`. The caller cannot provide Origin or return address.
- Source: requires active trusted Membership. It derives current Member name/Role, optional Crew display label, and canonical absolute source manifest path at execution time.
- Payload: keeps current Member Origin attribution and adds a bounded structured **Crew Return Address** containing the claimed source manifest path and optional Crew label. It never uses callback-only `replyTo`, session IDs, aliases, sockets, or content conventions as routing data.
- Delivery: reuses the existing manifest-load → `resolveIntakeContact` → durable Member Inbox enqueue seam. Success means persisted only; no endpoint probe, live notification, acknowledgement by recipient, or promised Response.
- Reply: receiver explicitly calls `send_to_crew` with the received Crew Return Address as target. Each turn is a new one-way persisted message. Multi-turn context is letter-style content/reference; no thread or correlation protocol in this task.
- Scope: same machine/filesystem only. No name registry, discovery, cross-machine transport, or automatic reply.

## Existing seams to reuse

- `src/application/external-intake.ts`: target Manifest loading, contact resolution, Inbox open/enqueue, stable intake errors and persisted acknowledgement.
- `src/cli/commands/crew-intake-adapter.ts`: exact `.pi/bebop/crew.json` / `.pi/crew/crew.json` path and caller-consent framing.
- `src/domain/message-payload.ts`: strict payload, Origin, size bounds; extend with a distinct Crew Return Address rather than overloading `ReplyToSchema`.
- `src/infra/membership-runtime.ts`: canonical active source `manifestPath`, Manifest, and Current Member.
- `src/pi/message-renderer.ts`: visibly render claimed Crew Origin and Crew Return Address; unlike callback `replyTo`, the return address must be visible because it is the reply affordance.

## Acceptance criteria

- [ ] Red tests first prove Crew A → Crew B persistence and Crew B → Crew A reply through two real supported layouts, with both contacts offline.
- [ ] Tool derives exact source Member Origin and canonical source manifest path from active Membership at execution; tool input cannot forge either.
- [ ] Received structured payload preserves content, ordered instructions, claimed Member Origin, optional Crew label, and Crew Return Address through Inbox persistence and handoff.
- [ ] Renderer labels Origin/return address as claimed and makes the return path available to the receiving agent without exposing any callback route, session ID, alias, socket, hidden instructions, or system prompt.
- [ ] Success returns bounded `itemId`, target contact identity, target manifest path, and `persisted:true`; wording never claims delivery, read, acknowledgement, Response, online state, or future availability.
- [ ] Unjoined, stale/lost Membership, non-absolute/self target, unsupported layout, traversal/symlink escape, unreadable/invalid Manifest, absent/unknown contact, invalid payload, capacity, lock, and storage failures reject deterministically without partial writes.
- [ ] Destination consent/trust matches explicit-path external intake: exact supported layout + configured `intake.contact` + filesystem permissions; it is never reported as Pi project trust or authenticated remote identity.
- [ ] Crew Return Address is a bounded canonical absolute path and remains claimed attribution after receipt. A stale/moved/malicious return address cannot trigger automatic IO; it fails only when a receiver explicitly invokes the tool.
- [ ] Existing standalone `send --crew <path>` remains one-way external intake and backward compatible; existing `MessagePayload` values without Crew Return Address remain valid.
- [ ] Focused application/domain/tool/renderer/inbox tests, unhappy paths, architecture/package checks, and fresh watcher gate pass.

## Non-goals

Crew-name addressing, machine-wide registry, discovery, cross-machine/network transport, automatic Responses, correlated request/Response semantics, read receipts, threads, authentication, encryption, or changing `intake.contact` routing.
