---
id: TASK-0147
title: Deliver durable Inbox items at recipient idle boundaries
status: todo
depends_on: [TASK-0145]
priority: high
tags: [crew, inbox, broadcast, idle, delivery, lifecycle, ux, tdd]
---

# Deliver durable Inbox items at recipient idle boundaries

## Problem

`send_to_inbox` and `broadcast_to_crew` durably persist recipient copies, but a
reachable idle Member is not guaranteed to receive the item immediately and an
item persisted while the Member is busy can wait beyond the Member's next true
idle boundary. Persistence without a deterministic offer trigger makes durable
coordination feel delayed even when the recipient is ready.

## Desired outcome

Durable Inbox delivery follows one recipient-owned rule:

- if the recipient is reachable and authoritatively idle after persistence, its
  oldest pending Inbox item is offered immediately as a normal Follow-up;
- if the recipient is busy or compacting, current work stays unchanged and the
  oldest pending item is offered at the next authoritative settled/idle round;
- if the recipient is offline, the item remains durable and is offered after
  restore/join reaches the first authoritative idle boundary.

This rule applies equally to a targeted `send_to_inbox` item and every
per-recipient copy created by `broadcast_to_crew`. Explicitly paused Inbox
offering remains paused.

## Context

"Immediately" means a same-operation, best-effort target notification followed
by acceptance at the target runtime's authoritative idle boundary. It is not a
wall-clock SLA or a sender-side Activity preflight. `turn_end` alone is not an
idle fact when retry, queued continuation, or compaction work remains.

Persistence stays authoritative. A failed, lost, or racing notification never
rolls back an accepted Inbox write and never loses the later idle/restore offer.
Crew Broadcast remains durable fan-out, not live-only multicast.

## Acceptance criteria

- [ ] Tests first cover targeted Inbox and Crew Broadcast delivery to idle,
      busy, compacting, offline, restoring, paused, and racing recipients.
- [ ] Each recipient copy is durably persisted before any best-effort live
      notification or offer attempt; notification failure never rolls back or
      changes the persisted disposition.
- [ ] A reachable recipient already at the authoritative idle boundary receives
      the oldest pending item during the initiating operation as one normal
      Follow-up, without a sender-side status preflight.
- [ ] A busy or compacting recipient keeps its current work unchanged: no
      rejected item is steered, redirected, interrupted, duplicated, or lost.
- [ ] The first authoritative settled/idle round after busy or compacting offers
      the oldest pending item exactly once. `turn_end` does not qualify while Pi
      still has retry, queued continuation, or compaction work.
- [ ] An offline recipient retains the item and offers it after restore/join at
      its first authoritative idle boundary without requiring sender retry.
- [ ] `send_to_inbox` and each `broadcast_to_crew` recipient copy use the same
      target-local offer rule, FIFO ordering, pause state, evidence-gated
      removal, and one-outstanding-item invariant.
- [ ] Explicit Inbox pause suppresses automatic idle offers; resume preserves
      pending order and enables the next eligible offer.
- [ ] Crew Broadcast still snapshots all other manifest members, persists
      deterministic per-recipient item IDs, excludes the sender, tolerates
      partial persistence failure, and deduplicates retries.
- [ ] Deterministic race tests prove one observable path per item: immediate
      idle offer or retained pending item followed by one later idle offer;
      never both, neither, or duplicate handoff.
- [ ] Sender-facing results distinguish durable persistence from best-effort
      notification and never claim the recipient read, completed, or answered
      the message.
- [ ] Tool descriptions, CLI help, README, architecture docs, and ubiquitous
      language explain the shared idle-offer rule for Inbox and Broadcast.
- [ ] Focused happy/unhappy tests, typecheck, formatting, architecture/package
      checks, full gates, fresh exact-clean watcher evidence, and independent
      exact-head QA pass.

## Non-goals

- Inferring urgency, progress, acknowledgement, willingness, or completion from
  mechanical Activity or idle state.
- Steering, redirecting, interrupting, aborting, polling, or automatically
  converting durable delivery into another messaging intent.
- A wall-clock delivery SLA, cross-machine push service, shared group turn,
  response aggregation, or exactly-once model execution claim.
- Changing explicit Inbox pause/cancel controls, arbitrary Broadcast recipient
  selection, or correlated Member Request/Response semantics.
