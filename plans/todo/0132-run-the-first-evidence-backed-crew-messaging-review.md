---
id: TASK-0132
title: Run the first evidence-backed Crew messaging review
status: todo
depends_on: [TASK-0131]
priority: normal
tags: [crew, messaging, retrospective, evidence, feedback, product, learning]
---

# Run the first evidence-backed Crew messaging review

## Problem

Mechanical usage evidence cannot reveal what Members prefer by itself, so the Crew needs one explicit review that combines a fixed message-log interval with equal Member feedback before proposing platform improvements.

## Desired outcome

Produce the first **Messaging Review**: a bounded evidence-backed learning record describing observed platform use, Members' attributed feedback, candidate interpretations, and small proposed trials. It informs later work but changes no messaging behavior automatically.

## Feedback collection contract

Reuse the existing correlated Member Request/Response and persisted Crew Retrospective round semantics—never Crew Board comments, generic Follow-up inference, or claimed message Origin. Explicit start snapshots the exact roster/interval, invokes TASK-0130's named pre-review coverage-collection operation, then freezes its immutable coverage snapshot ID/hash before any TASK-0131 read. It also persists `reviewId`, one stable logical request ID per Member, identical question bytes/hash, and one UTC deadline before sending. V1 deadline is an explicit whole-hour value from 1–336 hours, default 168 hours (7 days), measured from injected start time.

The responder must hold Current Membership under the exact frozen Member name when the Response is accepted; Role is irrelevant. The local facilitator uses the existing local-review seam rather than self-RPC. First valid in-window Response wins. Same replay is idempotent; conflicting duplicate never replaces it. Offline/timeout/malformed/oversized/restarted/missing are explicit. A frozen Member who leaves may respond only after rejoining under the same exact name before deadline through an explicit facilitator retry of the same logical slot; no automatic resend. A Member added after start is not a respondent in that review.

Late Response content cannot change current findings/proposals; retain only its attributed late marker/reference for the next review. Final record identity is persisted first, then announced through durable Inbox fan-out to every Current Member at publish time. Frozen Members who are no longer Current receive no delivery; newly joined Current Members may receive/pull it because TASK-0128 deliberately grants every Current Member all retained active-layout history.

## Acceptance criteria

- [ ] Facilitator explicitly starts the review with one fixed half-open UTC interval, exact Crew roster, one explicit TASK-0130 coverage collection and immutable snapshot ID/hash, Crew Message Log retention/gap state, collector version, stable per-Member request identities/question hash, persisted 1–336-hour deadline (default 168), and deterministic limits; there is no continuous monitoring or automatic start.
- [ ] Mechanical findings use Log Entry IDs and separate counts by surface/outcome/delivery intent, failure/retry/gap state, and bounded payload shape. They do not rank Members or label productivity, collaboration quality, sentiment, intent, preference, or completion.
- [ ] Every exact frozen-roster Member receives the same bounded question bytes through the existing correlated Member Request/Response flow (facilitator through local-review seam). Response is optional; silence/offline/timeout is not interpreted as preference or consent.
- [ ] Response-time exact-name Current Membership authenticates attribution. Tests cover leave/rejoin plus explicit same-slot retry, Role switch, Member added after start, removed frozen Member, wrong responder/request ID, restart, first-valid-wins replay, conflicting duplicate, malformed/oversized, deadline boundary, and late Response carry-forward.
- [ ] Member statements remain attributed, including disagreement and minority preferences. Claimed Origin in old entries never substitutes for the responding Member's current authenticated review identity.
- [ ] Evidence, Member observation, candidate interpretation, and proposal remain separate. Content examples are referenced/bounded/redacted rather than reproduced as an unbounded transcript.
- [ ] The review explicitly compares observed use with stated preference: non-use alone never means dislike, frequent use never means satisfaction, and failures never prove Member fault.
- [ ] Output contains a small prioritized set of falsifiable improvement proposals or Trial Agreements, each with problem, evidence IDs, affected surfaces, success signal, risks/privacy cost, and smallest next experiment.
- [ ] No proposal edits tools, delivery defaults, Crew Agreements, templates, or Member instructions automatically. Follow-up implementation receives new task IDs and normal Crew review.
- [ ] Missing/corrupt/pruned evidence and missing/late Member Responses remain visible. The record never claims whole-Crew consensus unless every Member explicitly agrees.
- [ ] The completed review is persisted/linked from the next Crew Retrospective evidence set, then its identity is announced through durable Inbox fan-out to publish-time Current Members. No content is privately duplicated; all Current Members—including later join/rejoin—use TASK-0128's equal retained-history pull access, while non-current frozen Members receive no delivery.
- [ ] A short product report states what was learned, what remains uncertain, which proposal should be tested first, and when to review the trial again.

## Non-goals

Employee monitoring, performance evaluation, Member scoring, sentiment surveillance, automatic feature prioritization, publishing message content outside the Crew, or building a generic analytics dashboard.
