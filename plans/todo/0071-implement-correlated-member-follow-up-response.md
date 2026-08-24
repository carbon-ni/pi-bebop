---
id: TASK-0071
title: Implement correlated crew-update coordination loop
status: doing
depends_on: [TASK-0068, TASK-0072]
priority: high
tags: [crew, messaging, response, correlation, orchestration, protocol, tdd]
---

# Implement correlated crew-update coordination loop

## Problem

Implement approved request/update workflow so safe lead coordination follows
from dedicated tool affordances and defaults rather than long role instructions
or member idle inference.

## Context

Implement TASK-0068 through isolated seams:

- pure request/update state machine with deterministic terminal races;
- persistent request-scoped RPC transport;
- thin `request_member`, `respond_to_member_request`, and
  `wait_for_crew_update` tool adapters;
- composition and concise prompt guidelines in `src/extension.ts`.

Build on TASK-0072's explicit preparation/delivery seams. Reuse
exact-name/unique-role resolution, structured Message Payload, and normal
Follow-up enqueue behavior without growing the legacy send orchestrator. Domain
owns no Pi, socket, timer, or filesystem IO.

## Acceptance criteria

- [ ] Tests first cover register-before-delivery, immediate response, response-before-idle, idle-without-response, offline, timeout, wait cancellation, late/duplicate reply, zero/one/multiple responder defaults, and capacity rejection.
- [ ] `request_member` requires member/message only, defaults empty instructions/300-second timeout, returns accepted request id immediately, and leaves source transport receiving one terminal event in background.
- [ ] Target registers inbound request before `pi.sendMessage`; context visibility arms idle detection and target settled emits idle only for armed unresolved requests.
- [ ] `respond_to_member_request` automatically chooses sole active inbound request; multiple require explicit request id; zero/expired provide ordinary Follow-up recovery without route disclosure.
- [ ] Response resolves requester only from target-local active request and writes once over request channel without enqueuing duplicate into requester Pi queue.
- [ ] Source buffers each terminal update once until consumed; `wait_for_crew_update` atomically returns oldest update or subscribes for next across all active requests.
- [ ] Empty `wait_for_crew_update` fails immediately with bounded self-correcting guidance; it never polls or starts an agent-preserving loop by itself.
- [ ] Multiple targets/requests resolve independently and out of assignment order without head-of-line blocking.
- [ ] Response wins same-boundary idle; timeout/offline/reload races release listeners, sockets, timers, and slots exactly once.
- [ ] Wait cancellation preserves active requests and buffered updates; accepted assignment is never claimed retracted.
- [ ] Strict schemas and named UTF-8/capacity bounds validate request ids, content, instructions, active requests, and buffered updates before mutation/IO where locally decidable.
- [ ] Tool descriptions and prompt guidelines make correct sequence discoverable without lead role assumptions or detailed workflow prompt.
- [ ] Existing accepted Follow-up/Redirect ordering, Inbox/Broadcast, Status, Member Idle Wait, direct session messaging, and CLI behavior remain compatible.
- [ ] Lifecycle integration runs two targets: both requests accepted before waiting, faster terminal update returns first, slower later returns independently, and empty registry yields explicit stop signal without sleeps.
- [ ] Negative integration proves pre-context target idle cannot resolve request and correlated response is visible exactly once only through wait tool result.
- [ ] Packaged extension test proves one-sentence lead instruction is sufficient for tool availability/guidance; documentation status changes to available only afterward.
- [ ] Focused coverage includes every state/error branch and fresh watcher final gate passes with unchanged worktree fingerprint.

## Out of scope

- CLI commands, durable/offline requests, cross-restart recovery, response
  streams, task state, or automatic integration decisions.
