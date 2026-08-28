---
id: TASK-0128
title: Define bounded Crew Message Log semantics
status: doing
depends_on: []
priority: high
tags: [crew, messaging, evidence, product, privacy, retention, ubiquitous-language]
---

# Define bounded Crew Message Log semantics

## Problem

Crew messaging is spread across transient delivery paths and durable queues, so the Crew cannot later inspect one honest, bounded record of how Bebop communication was used or where it caused friction.

## Desired outcome

Define a **Crew Message Log**: one project-local, append-only, Crew-readable evidence source containing Bebop-owned messaging lifecycle facts and a bounded, deterministically redacted representation of visible message content. It supports later review; it is not another delivery queue, conversation, monitoring feed, or source of inferred Member preference.

## Product contract

Normative source: `docs/CREW-MESSAGE-LOG.md`.

## Starting boundaries

- Visible Crew message content and ordered per-message instructions may be retained after deterministic credential/secret redaction and explicit byte limits. Hidden model reasoning is unavailable and never reconstructed.
- Current Membership is the only Bebop application access boundary. Every Current Member reads every retained entry in the active Crew log, including entries captured before that Member joined or rejoined; v1 has no capture-time roster ACL. Role switch changes attribution on later captures but never visibility. Leaving removes application access, and rejoining restores access to all still-retained history. A layout switch selects only the new active layout's log and never silently copies, merges, or exposes the inactive layout. This temporal policy must be named during join/discovery so historic visibility is not surprising.
- Membership-derived sender/target identity and wire `origin` remain separate. Origin is claimed attribution, never authentication. Callback routes, socket paths, stacks, raw dependency errors, credentials, and secrets are never log fields.
- A Log Entry describes one mechanical event such as accepted, queued, steered, persisted, handed off, responded, failed, timed out, or interrupted. Accepted/Persisted/Handoff/Response/idle/completion remain distinct.
- Capture is observational. A logging failure must not rewrite delivery intent or turn an otherwise accepted message into a different outcome; the missing evidence range must be reportable explicitly.
- Each capturing Member endpoint owns an injected `captureEpochId`, monotonic attempt sequence, durable epoch-open/checkpoint/clean-close markers, and a volatile pending-gap ledger capped at 256 merged ranges. An append failure merges adjacent attempts by endpoint/epoch/cause into `{firstSequence,lastSequence,firstOccurredAt,lastOccurredAt,attemptCount}`. Recovery persists stable gap IDs before later event/checkpoint bytes. Overflow coalesces to one wider `details-truncated` range without erasing that a gap existed.
- Volatile exact ranges may be lost on crash. At next successful epoch-open, absence of a prior clean close/checkpoint creates an `unverified-capture` interval from that endpoint's last durable checkpoint/close (or Retrospective interval start when none exists) to the new open time; event count is explicitly unknown. A process that never reached the store cannot prove its own existence, so review completeness is established only by durable per-roster endpoint coverage markers, never assumed from absent entries. TASK-0130's explicit pre-review coverage operation owns all endpoint interaction and freezes successes/unavailable outcomes as one immutable snapshot; TASK-0131 review queries consume only that snapshot.
- The Crew Message Log is distinct from the pull-only Crew Board and immutable Crew Retrospective Record. It can feed Retrospective evidence without becoming an Agreement, task, rating, notification, or automatic prompt injection.

## Acceptance criteria

- [x] `UL.md` and a normative contract define Crew Message Log, Log Entry, Messaging Review, and their relationships to Message, Origin, Membership, Crew Board, and Crew Retrospective.
- [x] The contract freezes an allow-listed v1 surface/outcome vocabulary covering Follow-up, Redirect, Member Request/Response, Member Inbox/Handoff, Crew Broadcast, Interrupt, and Crew Intake; generic non-Crew Pi/session traffic is explicitly included or excluded.
- [x] One closed Log Entry schema separates stable event/operation IDs, injected UTC occurrence time, surface, mechanical outcome, authenticated application-side Member identities when available, claimed Origin, delivery intent, correlation links, and bounded visible payload representation.
- [x] Exact per-field and aggregate UTF-8 limits, normalization, control-character handling, credential/secret redaction, reserved-marker spoof handling, and deterministic overflow/truncation order are fixed.
- [x] Exact retention bounds are fixed by both age and total storage/event capacity, including deterministic oldest-first pruning, transparent omitted interval/count evidence, restart behavior, and no unlimited transcript mode.
- [x] Access semantics encode the temporal policy above: equal Current-Member access to all retained active-layout history, internal capture-only append, no capture-time ACL, no caller-authored Log Entry tool, no private/member-only entries, no Role tiers, and no read receipts or per-Member read state.
- [x] Capture failure semantics freeze epoch/checkpoint/close markers, the 256-range volatile ledger, range merge/overflow/stable-ID rules, crash/restart loss, later gap persistence, and mandatory per-frozen-roster coverage reporting without fabricating events.
- [x] Same operation observed by multiple endpoints/adapters has one canonical identity and deterministic idempotent replay/conflict behavior; event ordering does not depend on wall-clock arrival order alone.
- [x] Content is evidence, not truth or preference. The contract forbids productivity scoring, Member ranking, sentiment/intent inference, inferred agreement, inferred completion, or treating silence/non-use as dislike.
- [x] Adversarial acceptance matrix covers secrets, spoofed Origin, cross-project/cross-layout identity, duplicate/reordered events, clock changes, oversized Unicode, retention boundaries, unavailable storage, Membership loss, and concurrent writers.
- [x] Dave confirms implementation readiness and Kelly independently accepts the product/privacy contract before storage work begins.

## Product evidence

- Normative contract: `docs/CREW-MESSAGE-LOG.md`.
- Canonical language: `UL.md` (`Crew Message Log`, `Log Entry`, `Messaging Review`).
- Readiness/adversarial matrix: `.tmp/reports/28-08-26/task-0128-crew-message-log-contract-readiness.md`.

## Non-goals

Implementing storage or live capture; recording hidden reasoning/provider prompts; OS-level filesystem confidentiality; cryptographic message authentication; remote/network synchronization; analytics dashboards; automatic product decisions; changing current delivery semantics.
