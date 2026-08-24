---
id: TASK-0072
title: Refactor member message delivery pipeline
status: todo
depends_on: []
priority: high
tags: [refactor, messaging, application, delivery, separation-of-concerns, tdd]
---

# Refactor member message delivery pipeline

## Problem

`sendMemberMessage` in `src/application/member-message.ts` currently owns too
many decisions: membership validation, exact-name/unique-role resolution,
self-send rejection, intent/correlation validation, origin and payload creation,
endpoint lookup, RPC command construction, transport failure translation,
acknowledgement validation, and endpoint ordering. Adding correlated request
transport directly would make an already mixed orchestration function harder to
test and change.

## Context

Perform a behavior-preserving preparatory refactor before TASK-0071. Keep
`sendMemberMessage` as the existing public operation, but make its stages
explicit:

1. **Prepare** — validate request, resolve recipient, derive origin, construct
   and validate payload/command without IO.
2. **Resolve** — obtain endpoint only after local preparation succeeds.
3. **Deliver** — send command and translate lost acknowledgement, remote
   rejection, and invalid acknowledgement into current stable outcomes.
4. **Order** — immediate intent delivers directly; Follow-up uses existing
   per-endpoint coordinator.

Prefer small named functions and data shapes over new classes or generic
pipeline framework. Extract a shared application-level recipient resolver only
if TASK-0071 has a concrete second caller; do not move transport or application
errors into pure domain merely to reduce file length.

## Acceptance criteria

- [ ] Characterization tests are written first for every current public result/error: not joined, exact name, unique role, ambiguous role, unknown member, self-send by name/path, unsupported response correlation, invalid payload, endpoint failure, remote rejection, invalid ack, lost ack/outcome unknown, immediate delivery, queued Follow-up, and cancellation.
- [ ] Tests assert side-effect order: all locally decidable validation precedes endpoint resolution; endpoint resolution precedes queue/send; invalid local requests perform no endpoint or transport IO.
- [ ] `sendMemberMessage` becomes a short orchestration function delegating named prepare/deliver/order stages, with early returns and no nested transport/error protocol details.
- [ ] Pure preparation returns an explicit immutable prepared-delivery shape containing target, delivery intent, and validated RPC command; it performs no socket, timer, filesystem, or Pi IO.
- [ ] Delivery stage owns transport invocation and acknowledgement/error normalization only; it does not resolve membership, construct payload, or choose ordering.
- [ ] Endpoint coordinator remains responsible only for per-endpoint FIFO and cancellation; its behavior and capacity semantics remain unchanged.
- [ ] Existing exported types/functions and `MemberMessageError` codes/messages remain compatible; tool text/details, RPC wire payload, origin attribution, delivery id/disposition, and Follow-up/Redirect ordering remain byte/semantically unchanged.
- [ ] Existing `wait_for: "response"` unsupported result remains unchanged; TASK-0072 does not implement or partially expose correlated requests.
- [ ] New helper is exported only when TASK-0071 demonstrates immediate reuse; otherwise keep it module-private to avoid speculative API.
- [ ] No generic pipeline abstraction, DI container, new class hierarchy, protocol change, tool registration, CLI change, or unrelated cleanup is introduced.
- [ ] Complexity evidence shows `sendMemberMessage` no longer mixes preparation and transport branches; focused tests and touched-code coverage pass.
- [ ] Fresh final watcher gate passes with unchanged worktree fingerprint.

## Out of scope

- Correlated request/reply behavior, new tools, request registries, persistent
  request channels, message schema changes, CLI parity, or idle semantics.

## Verification

- Focused member-message/tool adapter tests.
- Structural review of stage responsibilities and exported surface.
- Touched-code coverage plus fresh final watcher gate.
