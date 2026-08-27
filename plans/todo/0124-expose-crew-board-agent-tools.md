---
id: TASK-0124
title: Expose shared Crew Board operations and agent tools
status: doing
depends_on: [TASK-0123]
priority: high
tags: [crew, board, application, tools, membership, collaboration, tdd]
---

# Expose shared Crew Board operations and agent tools

## Problem

Autonomous Members cannot use the shared board unless membership-scoped operations expose bounded append and read behavior without sending messages, starting extra turns, or duplicating rules in each public surface.

## Public surface

```text
leave_crew_post({
  kind?: "tip" | "kudos" | "feedback" | "warning" | "note",
  message: string,
  references?: string[],
  link?: { relation: "supersedes" | "disputes", post_id: string }
})

read_crew_board({
  kinds?: string[],
  after?: string,
  limit?: number
})
```

## Implementation plan

1. Write failing application tests for Membership gating, author derivation, canonical append/read results, and zero delivery side effects.
2. Add injected application operations independent of Pi tool/command types so TASK-0125 reuses the same validation, store, ordering, and errors.
3. Register compact agent tools that adapt parameters/results only; Membership and manifest are resolved at execute time.
4. Activate/deactivate board tool access through the existing Membership tool lifecycle. Add one bounded stable joined-context affordance line naming both tools, but never load Crew Post content automatically.

## Acceptance criteria

- [ ] Every Current Member receives identical append/read capability after join/restore/rejoin; Role, description, contact/facilitator/Lead convention, post kind, and claimed Origin never change access.
- [ ] Unjoined, inactive, removed, untrusted, stale-membership, or unsupported-layout execution rejects before Board store IO with actionable bounded errors.
- [ ] Author name/Role attribution is derived from the exact active manifest-backed Membership at append time, never accepted from tool arguments. Role remains attribution only.
- [ ] Tool schemas are closed and bounded. Invalid kind/list, empty or oversized message, duplicate/unsafe references, invalid/missing/foreign/self/future link, same-author supersedes violation, cursor, and limit reject before mutation. Exactly one optional canonical link object replaces ambiguous parallel supersedes/disputes fields.
- [ ] Append returns stable post identity/sequence/time and an honest persisted acknowledgement; it never claims delivery, reading, agreement, correctness, or benefit.
- [ ] Read returns compact deterministic posts plus cursor/truncation metadata in store order; kind filters affect display only and never infer recipient/importance/sentiment.
- [ ] Exact tool-call retry is idempotent; conflicting retry is explicit and cannot overwrite a prior post.
- [ ] Append/read perform zero Follow-up, Inbox, Crew Broadcast, Member request/Response, Redirect, Interrupt, provider, task, Agreement, or Retrospective mutation side effects.
- [ ] Reading never consumes, marks read, acknowledges, or creates per-Member state. Leaving/rejoining sees the same shared board.
- [ ] Tool descriptions teach pull-only semantics, Membership-only access, potentially fallible content, absence of notification/read receipts/ratings/authority, and useful voluntary triggers: inspect when starting unfamiliar work or seeking shared project context; append when a reusable tip, kudos, feedback, warning, or note should outlive the current session.
- [ ] Joined/restored/rejoined Membership context includes exactly one concise stable line: use `read_crew_board` to inspect shared Posts and `leave_crew_post` to add one; Posts are not delivered automatically. It includes no Post count/body/reference/cursor and does not duplicate across prompt construction.
- [ ] Membership loss, abort, store failure, corruption, capacity, and concurrent operation paths clean resources once and return bounded errors.
- [ ] Existing Membership tool activation order and all messaging/public-context tests remain green; only the bounded affordance is added, and Crew Post content is never inserted automatically into system or message context.

## Non-goals

Slash commands, direct recipients/mentions, replies/threads, likes/ratings, automatic reading, automatic promotion, or moderation.
