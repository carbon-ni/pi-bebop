---
id: TASK-0122
title: Define Crew Board and Crew Post semantics
status: todo
depends_on: []
priority: high
tags: [crew, board, collaboration, product, ubiquitous-language, persistence, determinism]
---

# Define Crew Board and Crew Post semantics

## Problem

Crew Members need durable shared tips, kudos, feedback, warnings, and notes without turning them into direct delivery, ratings, authority, or task state.

## Desired outcome

Define one pull-based Crew Board shared equally by every Current Member and one bounded Crew Post contract that later storage, tool, and command tasks can implement without inventing access, authority, or delivery semantics.

## Product decisions to record

- Canonical terms are **Crew Board** and **Crew Post**.
- Crew Membership is the only access boundary. Every Current Member has identical read-and-append access; there are no per-Member ACLs, private posts, Role permissions, owners, moderators, or tiers.
- A post may be labelled `tip`, `kudos`, `feedback`, `warning`, or `note`; the optional kind is browsing metadata only. Bebop never infers kind, recipient, sentiment, importance, or workflow from prose.
- Board is pull-based. Append/read never delivers a message, injects model context, starts a turn, creates a Response/read receipt, or claims acknowledgement.
- Posts are attributed statements, not verified truth, instructions, task state, votes, ratings, Agreements, or authority.
- Correction is a new linked post; existing bytes/provenance are never silently edited.

## Acceptance criteria

- [ ] `UL.md` and one focused contract define Crew Board/Crew Post and distinguish them from Follow-up, Inbox, Member request, Crew Broadcast, task/plan state, AGENTS.md, Current Crew Agreements, and Retrospective evidence.
- [ ] Membership-only access is exact: every joined/restored/rejoined Current Member can read and append; no Role, Origin, facilitator, Lead convention, or post kind changes that access.
- [ ] Contract defines a closed bounded canonical post shape: version, stable ID, stable sequence/cursor, injected UTC creation time, manifest-backed author attribution, optional kind, bounded message, safe references, and optional supersedes/disputes link.
- [ ] Contract defines deterministic ordering, cursor/pagination, capacity, exact retry/idempotency, conflicting replay, corruption, restart, and concurrent-writer outcomes.
- [ ] Pull-only behavior explicitly creates no recipient, delivery state, read/acceptance state, automatic notification, provider call, or model-context injection.
- [ ] Tips/feedback/kudos remain fallible Member statements; no aggregation into ratings, reputation, sentiment, productivity, performance, consensus, or authority is allowed.
- [ ] Credentials/secrets, hidden model reasoning, unsafe paths/identifiers, unbounded attachments/history, anonymous external posting, automatic promotion, and cross-project/network replication boundaries are explicit.
- [ ] A deliberate later process may promote useful posts into documentation, tests, plans, AGENTS.md, or Crew Agreements; Board append itself never performs promotion.
- [ ] Contract specifies one active-manifest-adjacent runtime store (`.pi/bebop/board` or compatibility `.pi/crew/board`), not mirrored and not per-Member.
- [ ] Independent product review finds no contradiction with existing messaging, Membership, Agreement, Retrospective, or project-layout terminology.

## Non-goals

Implementation, direct messages, threads, reactions/likes, ratings, moderation roles, private posts, task management, automatic prompt injection, automatic truth checking, or cross-machine synchronization.
