---
id: TASK-0128
title: Define bounded Crew Message Log semantics
status: todo
depends_on: []
priority: high
tags: [crew, messaging, evidence, product, privacy, retention, ubiquitous-language]
---

# Define bounded Crew Message Log semantics

## Problem

Crew messaging is spread across transient delivery paths and durable queues, so the Crew cannot later inspect one honest, bounded record of how Bebop communication was used or where it caused friction.

## Desired outcome

Define a **Crew Message Log**: one project-local, append-only, Crew-readable evidence source containing Bebop-owned messaging lifecycle facts and a bounded, deterministically redacted representation of visible message content. It supports later review; it is not another delivery queue, conversation, monitoring feed, or source of inferred Member preference.

## Starting boundaries

- Visible Crew message content and ordered per-message instructions may be retained after deterministic credential/secret redaction and explicit byte limits. Hidden model reasoning is unavailable and never reconstructed.
- Current Membership is the only Bebop application access boundary. Every Current Member has equal read access; Role, Origin, message kind, and Lead convention grant no extra authority. Leaving removes application access but not prior attributed entries.
- Membership-derived sender/target identity and wire `origin` remain separate. Origin is claimed attribution, never authentication. Callback routes, socket paths, stacks, raw dependency errors, credentials, and secrets are never log fields.
- A Log Entry describes one mechanical event such as accepted, queued, steered, persisted, handed off, responded, failed, timed out, or interrupted. Accepted/Persisted/Handoff/Response/idle/completion remain distinct.
- Capture is observational. A logging failure must not rewrite delivery intent or turn an otherwise accepted message into a different outcome; the missing evidence range must be reportable explicitly.
- The Crew Message Log is distinct from the pull-only Crew Board and immutable Crew Retrospective Record. It can feed Retrospective evidence without becoming an Agreement, task, rating, notification, or automatic prompt injection.

## Acceptance criteria

- [ ] `UL.md` and a normative contract define Crew Message Log, Log Entry, Messaging Review, and their relationships to Message, Origin, Membership, Crew Board, and Crew Retrospective.
- [ ] The contract freezes an allow-listed v1 surface/outcome vocabulary covering Follow-up, Redirect, Member Request/Response, Member Inbox/Handoff, Crew Broadcast, Interrupt, and Crew Intake; generic non-Crew Pi/session traffic is explicitly included or excluded.
- [ ] One closed Log Entry schema separates stable event/operation IDs, injected UTC occurrence time, surface, mechanical outcome, authenticated application-side Member identities when available, claimed Origin, delivery intent, correlation links, and bounded visible payload representation.
- [ ] Exact per-field and aggregate UTF-8 limits, normalization, control-character handling, credential/secret redaction, reserved-marker spoof handling, and deterministic overflow/truncation order are fixed.
- [ ] Exact retention bounds are fixed by both age and total storage/event capacity, including deterministic oldest-first pruning, transparent omitted interval/count evidence, restart behavior, and no unlimited transcript mode.
- [ ] Access semantics are explicit: equal Current-Member read, internal capture-only append, no caller-authored Log Entry tool, no private/member-only entries, no Role tiers, and no read receipts or per-Member read state.
- [ ] Capture failure semantics distinguish message outcome from evidence outcome and define how partial/unavailable intervals become honest Retrospective gaps without fabricating events.
- [ ] Same operation observed by multiple endpoints/adapters has one canonical identity and deterministic idempotent replay/conflict behavior; event ordering does not depend on wall-clock arrival order alone.
- [ ] Content is evidence, not truth or preference. The contract forbids productivity scoring, Member ranking, sentiment/intent inference, inferred agreement, inferred completion, or treating silence/non-use as dislike.
- [ ] Adversarial acceptance matrix covers secrets, spoofed Origin, cross-project/cross-layout identity, duplicate/reordered events, clock changes, oversized Unicode, retention boundaries, unavailable storage, Membership loss, and concurrent writers.
- [ ] Dave confirms implementation readiness and Kelly independently accepts the product/privacy contract before storage work begins.

## Non-goals

Implementing storage or live capture; recording hidden reasoning/provider prompts; OS-level filesystem confidentiality; cryptographic message authentication; remote/network synchronization; analytics dashboards; automatic product decisions; changing current delivery semantics.
