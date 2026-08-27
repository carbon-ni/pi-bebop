---
id: TASK-0112
title: Collect Bebop coordination evidence for retrospectives
status: todo
depends_on: [TASK-0111]
priority: high
tags: [crew-agreements, retrospective, evidence, messaging, coordination, tdd]
---

# Collect Bebop coordination evidence for retrospectives

## Problem
Important coordination situations already occur through Bebop, but without a bounded collector the Crew must remember request outcomes, Interrupts, delivery failures, and lifecycle problems manually.

## Context
Collect facts Bebop owns; never reinterpret mechanical states as intent, productivity, agreement, or completion.

## Acceptance criteria
- [ ] Allow-listed collector emits evidence for Member request/Response outcomes, delivery failures/dispositions, Inbox/Crew Broadcast outcomes, Interrupt lifecycle, and relevant Membership/control failures within one exact interval.
- [ ] Each item retains canonical IDs and outcome vocabulary; timeout, offline, Accepted, Persisted, Handoff, idle, and completion are never conflated.
- [ ] Visible Crew message content may be referenced or bounded/redacted, while hidden reasoning is unavailable and credentials are removed.
- [ ] Activity/Presence may appear only as mechanical context and never as productivity, intent, availability, or semantic interpretation.
- [ ] Same event observed through multiple paths deduplicates through TASK-0111 fingerprints; repeated collection is idempotent and deterministic.
- [ ] Missing, corrupt, rotated, oversized, or partially unavailable coordination evidence is reported honestly with retained source boundaries.
- [ ] Collection is read-only with respect to messaging, never starts turns, sends messages, changes Inbox state, or activates Agreements.
- [ ] Focused tests cover every event family, interval boundaries, ordering, deduplication, redaction, unavailable sources, and UL distinctions.

## Non-goals
Repository/session collection, semantic situation synthesis, continuous monitoring UI, or task/progress inference.
