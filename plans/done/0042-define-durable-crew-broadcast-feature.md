---
id: TASK-0042
title: Define durable crew broadcast feature
status: done
depends_on: [TASK-0034]
priority: high
tags: [crew, broadcast, inbox, domain, ubiquitous-language]
---

# Define durable crew broadcast feature

## Problem
Joined members sometimes need to share one announcement or constraint with the whole crew, but repeating direct sends is error-prone and online-only delivery can omit offline members; broadcast semantics must remain distinct from external intake and urgent redirection.

## Context

Define **Crew Broadcast** as internal, durable, non-interrupting fan-out initiated by current joined member. Same structured message is persisted independently to every other member configured by current trusted manifest, regardless of presence. Sender is excluded.

Broadcast is not external intake, shared inbox, group turn, or redirect-all. Each recipient later receives own Inbox item through normal follow-up handoff. External actor cannot broadcast; they message Crew Intake contact, who may choose to broadcast as joined member.

Fan-out cannot be assumed atomic across files. Use stable broadcast ID plus deterministic per-recipient item identity so retry fills missing recipients without duplicating successful copies. Result must report every target disposition.

## Acceptance criteria

- [ ] `UL.md` defines Crew Broadcast and distinguishes it from direct follow-up, redirect, Inbox, and Crew Intake.
- [ ] Only current joined member may initiate; unjoined/external callers are rejected before persistence.
- [ ] Recipient set is manifest snapshot in manifest order, excluding sender by canonical member identity—not name/role heuristics.
- [ ] Online/offline presence does not change recipients or order.
- [ ] Broadcast persists same content/instructions and derived crew origin separately for every recipient Inbox.
- [ ] Delivery is always non-interrupting Inbox-to-follow-up; broadcast cannot steer or redirect active work.
- [ ] Stable broadcast ID and deterministic recipient item IDs make retry idempotent after partial failure/crash.
- [ ] Result distinguishes persisted, already-persisted, and failed for each recipient; partial success is never presented as total success.
- [ ] Inbox capacity and one recipient failure do not corrupt successful recipients or silently lose failed target.
- [ ] Empty crew-after-self exclusion returns explicit no-recipients result without storage IO.
- [ ] Domain tests cover manifest order, self exclusion, offline members, duplicate retry, partial failure, and origin derivation.

## Out of scope

- External broadcast, redirect-all, response aggregation, role filters, arbitrary subsets, shared group conversation, topic routing, permissions by role, or cross-project/network delivery.

