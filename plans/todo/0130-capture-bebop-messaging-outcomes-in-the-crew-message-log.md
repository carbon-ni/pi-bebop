---
id: TASK-0130
title: Capture Bebop messaging outcomes in the Crew Message Log
status: todo
depends_on: [TASK-0129]
priority: high
tags: [crew, messaging, evidence, application, lifecycle, integration, tdd]
---

# Capture Bebop messaging outcomes in the Crew Message Log

## Problem

A log store alone is not useful unless every supported Crew messaging operation records the same canonical lifecycle facts at shared application boundaries without adapter gaps or changed delivery semantics.

## Context

Capture at shared domain/application seams, not separately in each CLI/tool/Pi adapter. Reuse the existing structured `MessagePayload`, delivery/correlation IDs, canonical coordination outcome vocabulary, and TASK-0112 evidence model where compatible. Do not create a second competing event vocabulary silently.

## Acceptance criteria

- [ ] A failing matrix first enumerates every TASK-0128 surface and mechanical outcome, then proves each shared operation emits the canonical Log Entry exactly once regardless of tool, CLI, Pi command, startup, Inbox bridge, or retry adapter.
- [ ] Follow-up and Redirect preserve exact delivery intent; Member Request and Response preserve correlation; Inbox and Broadcast distinguish persistence from handoff; Interrupt distinguishes pending/abort/direct/handoff; Crew Intake remains explicitly external/unverified.
- [ ] Application-authenticated current source/target Member identity is derived at execution time and stored separately from claimed wire Origin. Role switch, leave/rejoin, external input, spoofed origin, self/unknown target, and cross-project cases cannot forge Membership identity.
- [ ] Visible content and ordered instructions pass through TASK-0128's normalization, redaction, bounds, and marker-spoof policy before persistence. Callback routes, sockets, raw errors, stacks, hidden reasoning, and system/Role instructions never enter Log Entries.
- [ ] Stable existing operation/delivery/request/inbox/broadcast/interrupt IDs drive event identity. Multiple endpoints or adapter retries converge through idempotent replay rather than duplicate entries.
- [ ] Ordering under concurrent Follow-up, Redirect, Broadcast fan-out, Inbox handoff, Response, restart, and same-boundary failure is deterministic from canonical lifecycle/sequence fields, not filesystem enumeration or observer arrival alone.
- [ ] Log append never changes message acceptance, mode, FIFO, retry, response, timeout, cancellation, or cleanup behavior. Each endpoint opens one capture epoch, sequences every attempt, checkpoints/cleanly closes, records append failures in the 256-range volatile ledger, flushes stable gap markers before later success, and emits an actionable diagnostic without changing the original outcome.
- [ ] Crash/restart tests prove volatile exact details may be lost but cannot become a false complete interval: next successful epoch plus prior durable markers yields an explicit unverified range, and an endpoint that never established durable coverage is reported unknown for the relevant review interval.
- [ ] Unsupported/generic session traffic is excluded exactly as TASK-0128 specifies; absence is explicit rather than partially captured through incidental adapters.
- [ ] Real-boundary integration proves accepted, failed, offline, timed-out, replayed, and partially unavailable paths across both Crew layouts and restart, including no dropped original message and no invented successful Log Entry.
- [ ] One explicit pre-review `collectCrewMessageLogCoverage` application operation freezes roster/interval, uses injected endpoint checkpoint requests with one operation-wide bounded deadline, persists each success/unavailable/timeout as canonical coverage evidence, then freezes one immutable snapshot ID/hash. It is a capture/write operation invoked only by explicit review orchestration—not a log query—and never changes message delivery semantics.
- [ ] Coverage retries use stable review/roster/interval/endpoint identities; duplicate success is idempotent, late/conflicting replies cannot replace the frozen snapshot, Membership/endpoint loss becomes an explicit gap, and restart resumes without duplicate checkpoint effects.
- [ ] Existing TASK-0112 coordination evidence can consume canonical persisted events and the immutable coverage snapshot through an injected finite read-only source without sending messages, requesting checkpoints, or mutating log/Inbox state.
- [ ] Focused and regression tests, package verification, architecture gate, and watcher final gate pass.

## Non-goals

Adding review tools/commands, semantic analytics, changing transport protocol solely for logging, recording provider/model internals, or making Log persistence a new acknowledgement/completion guarantee.
