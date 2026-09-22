---
id: TASK-0217
title: Guarantee Follow-up never interrupts active work
status: done
depends_on: []
priority: high
tags: [crew, messaging, follow-up, queue, lifecycle, regression, tdd]
---

# Guarantee Follow-up never interrupts active work

## Problem

`send_follow_up` is intended for non-urgent information, but the delivery boundary has not been proven end to end to stay behind active agent work. A Follow-up must never steer, abort, replace, or shorten an active turn. Only `redirect_member` or `interrupt_member` may deliberately disrupt active work.

## Desired outcome

A sender can use `send_follow_up` without changing what the recipient is doing now. Pi owns the delivery decision: it queues the message with `deliverAs: "followUp"` while work is active and starts a normal turn only when the recipient is idle.

## Acceptance criteria

- [x] Every live `send_follow_up` delivery to a Member or approved Guest reaches Pi with `triggerTurn: true` and `deliverAs: "followUp"`; no local idle snapshot may downgrade it to implicit/default delivery.
- [x] When the recipient is streaming, executing tools, or compacting, the current turn and its remaining tool calls finish before the Follow-up enters model context.
- [x] When the recipient is idle, the same Follow-up mode starts one normal turn without requiring a different transport path.
- [x] Follow-up delivery never invokes abort, steer, redirect, interrupt, or replacement behavior. `redirect_member` continues to use `deliverAs: "steer"`; `interrupt_member` remains the only hard-abort path.
- [x] Releasing a blocking Member Idle Wait or Request outcome wait because a Follow-up arrived does not classify the message as urgent or discard it; the unchanged Follow-up is consumed once at the next continuation boundary.
- [x] The acknowledgement distinguishes accepted/direct/queued honestly without claiming the recipient read, acted on, or completed the message.
- [x] Offline recipients remain an explicit error; this task does not silently turn Follow-up into durable Inbox delivery.
- [x] Deterministic unit and real-runtime integration tests cover idle, streaming, tool execution, compaction, activity-transition races, Member and approved Guest recipients, wait release, FIFO order, and contrast with Redirect/Interrupt.
- [x] Tool descriptions and CLI/help use one contract: Follow-up is non-interrupting; Redirect is urgent steering; Interrupt is emergency recovery.

## Non-goals

Durable offline delivery, priority queues, cancellation of accepted messages, changing Member Request correlation, or treating delivery as proof of attention or completion.
