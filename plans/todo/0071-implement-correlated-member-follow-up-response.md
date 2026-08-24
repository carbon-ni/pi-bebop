---
id: TASK-0071
title: Implement correlated crew-update coordination loop
status: todo
depends_on: [TASK-0068]
priority: high
tags: [crew, messaging, response, correlation, orchestration, protocol, tdd]
---

# Implement correlated crew-update coordination loop

## Problem

The approved coordination contract needs an end-to-end implementation so a
lead can delegate concurrently, receive the first relevant crew update, and
continue its loop without using member idle as a response proxy.

## Context

Implement TASK-0068 as three isolated seams:

- pure request/update state machine with capacity and terminal-race rules;
- request-scoped RPC transport that remains open after assignment acceptance;
- thin tool adapters extending `send_follow_up` and registering
  `wait_for_crew_update`.

Keep composition in `src/extension.ts`; domain owns no Pi/socket/time IO. Reuse
current exact-name/unique-role resolution and structured Message Payload rules.

## Acceptance criteria

- [ ] Tests first cover register-before-delivery, immediate response, response-before-idle, idle-without-response, offline, timeout, wait cancellation, late/duplicate reply, and capacity rejection.
- [ ] `send_follow_up(expect_reply=true)` returns accepted request id immediately while source transport continues receiving one terminal request event in background.
- [ ] Target request state is registered before `pi.sendMessage`; context visibility arms idle detection, and target settled emits idle only for armed unresolved requests.
- [ ] `send_follow_up(in_reply_to=...)` resolves requester exclusively from active target-local request state and writes one response event without enqueuing duplicate response into requester's Pi queue.
- [ ] Source registry buffers each terminal update exactly once until consumed; `wait_for_crew_update` atomically returns oldest accepted update or subscribes for next across all pending requests.
- [ ] Multiple targets and multiple requests to same target resolve independently and may complete out of assignment order without head-of-line blocking.
- [ ] Response deterministically wins same-boundary idle; timeout/offline/cancel/reload races release listeners, sockets, timers, and registry slots exactly once.
- [ ] Wait cancellation preserves pending requests and buffered updates; assignment cancellation after accepted delivery never claims rollback.
- [ ] Unknown/expired/wrong-target/replayed `in_reply_to` cannot disclose callback route or consume live request; stable recovery guidance uses ordinary `send_follow_up`.
- [ ] Strict schemas and named UTF-8/capacity bounds apply to request ids, content, instructions, active requests, and buffered updates before mutation/IO where locally decidable.
- [ ] Tool descriptions and joined context teach `expect_reply`, `in_reply_to`, and `wait_for_crew_update` without adding lead-only permission semantics.
- [ ] Existing accepted Follow-up/Redirect ordering, durable Inbox/Broadcast, Member Status, Member Idle Wait, direct session messaging, and public CLI behavior remain compatible.
- [ ] Lifecycle integration test runs two target members: both assignments are accepted before waiting, faster response returns first, slower target later returns independently, and loop reaches explicit no-pending stop without sleeps.
- [ ] Negative integration proves target idle before request message context does not produce false idle, and correlated response is visible exactly once only through waiting tool result.
- [ ] Update `docs/CORRELATED-CREW-UPDATE-WORKFLOW.md` from planned to available only after packaged extension test proves complete loop.
- [ ] Focused coverage includes every state transition/error and fresh final watcher gate passes with unchanged worktree fingerprint.

## Out of scope

- CLI commands, durable/offline requests, cross-restart recovery, multiple
  responses, progress streams, task state, or automatic integration decisions.
