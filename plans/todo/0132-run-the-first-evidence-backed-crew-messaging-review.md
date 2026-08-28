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

## Acceptance criteria

- [ ] Facilitator explicitly starts the review with one fixed half-open UTC interval, exact Crew roster, Crew Message Log retention/gap state, collector version, and deterministic limits; there is no continuous monitoring or automatic start.
- [ ] Mechanical findings use Log Entry IDs and separate counts by surface/outcome/delivery intent, failure/retry/gap state, and bounded payload shape. They do not rank Members or label productivity, collaboration quality, sentiment, intent, preference, or completion.
- [ ] Every exact roster Member receives the same bounded questions about which surfaces they used, preferred, avoided, found confusing, trusted, or wished existed, plus what should start/stop/continue. Response is optional; silence/offline/timeout is not interpreted as preference or consent.
- [ ] Member statements remain attributed, including disagreement and minority preferences. Claimed Origin in old entries never substitutes for the responding Member's current authenticated review identity.
- [ ] Evidence, Member observation, candidate interpretation, and proposal remain separate. Content examples are referenced/bounded/redacted rather than reproduced as an unbounded transcript.
- [ ] The review explicitly compares observed use with stated preference: non-use alone never means dislike, frequent use never means satisfaction, and failures never prove Member fault.
- [ ] Output contains a small prioritized set of falsifiable improvement proposals or Trial Agreements, each with problem, evidence IDs, affected surfaces, success signal, risks/privacy cost, and smallest next experiment.
- [ ] No proposal edits tools, delivery defaults, Crew Agreements, templates, or Member instructions automatically. Follow-up implementation receives new task IDs and normal Crew review.
- [ ] Missing/corrupt/pruned evidence and missing/late Member Responses remain visible. The record never claims whole-Crew consensus unless every Member explicitly agrees.
- [ ] The completed review is linked from the next Crew Retrospective evidence set and shared with every Current Member through an existing explicit pull/durable mechanism without changing Crew Board or message read state.
- [ ] A short product report states what was learned, what remains uncertain, which proposal should be tested first, and when to review the trial again.

## Non-goals

Employee monitoring, performance evaluation, Member scoring, sentiment surveillance, automatic feature prioritization, publishing message content outside the Crew, or building a generic analytics dashboard.
