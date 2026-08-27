---
id: TASK-0122
title: Define Crew Board and Crew Post semantics
status: done
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
- Board is pull-based. Append/read never delivers a message, injects Board Post content automatically, starts a turn, creates a Response/read receipt, or claims acknowledgement.
- Discoverability is explicit: joined Membership context teaches the two board tools in one bounded stable affordance line, and human join/help surfaces teach the slash commands. Teaching that the Board exists is distinct from pushing Board content.
- Posts are attributed statements, not verified truth, instructions, task state, votes, ratings, Agreements, or authority.
- Correction is a new linked post; existing bytes/provenance are never silently edited.

## Acceptance criteria

- [x] `UL.md` and one focused contract define Crew Board/Crew Post and distinguish them from Follow-up, Inbox, Member request, Crew Broadcast, task/plan state, AGENTS.md, Current Crew Agreements, and Retrospective evidence.
- [x] Membership-only access is exact: every joined/restored/rejoined Current Member can read and append; no Role, Origin, facilitator, Lead convention, or post kind changes that access.
- [x] Contract defines a closed bounded canonical post shape: version, stable ID, stable sequence/cursor, injected UTC creation time, manifest-backed author attribution, optional kind, bounded message, safe references, deterministic redaction metadata, and at most one explicit `supersedes|disputes` link.
- [x] Contract defines deterministic ordering, cursor/pagination, capacity, exact retry/idempotency, conflicting replay, corruption, restart, and concurrent-writer outcomes.
- [x] Pull-only behavior explicitly creates no recipient, delivery state, read/acceptance state, automatic notification, provider call, or automatic Crew Post content injection.
- [x] Contract defines bounded discovery: every joined/restored/rejoined Member sees one stable tool-affordance line; tool descriptions teach when/how to read or append; human join/help lists `/crew board` and `/crew post`. No Post is read merely because Membership starts.
- [x] Tips/feedback/kudos remain fallible Member statements; no aggregation into ratings, reputation, sentiment, productivity, performance, consensus, or authority is allowed.
- [x] Secret handling is deterministic: canonical message redaction occurs before fingerprint/persistence, sensitive references reject before write, raw sensitive bytes never enter IDs/logs/errors, and exact retry compares persisted redacted form. Hidden reasoning, unsafe paths/identifiers, unbounded attachments/history, anonymous external posting, automatic promotion, and cross-project/network replication boundaries are explicit.
- [x] A deliberate later process may promote useful posts into documentation, tests, plans, AGENTS.md, or Crew Agreements; Board append itself never performs promotion.
- [x] Contract specifies one active-manifest-adjacent runtime store (`.pi/bebop/board` or compatibility `.pi/crew/board`), not mirrored and not per-Member.
- [x] Independent product review finds no contradiction with existing messaging, Membership, Agreement, Retrospective, or project-layout terminology.

## Acceptance evidence

- Product contract: `docs/CREW-BOARD.md`.
- Canonical terminology/relationships/ambiguities/verbs: `UL.md`.
- QA matrix: `.tmp/reports/27-08-26/task-0122-crew-board-contract-acceptance-matrix.md` — ACCEPT after deterministic secret/link corrections.
- Dev readiness review: all 11 requested storage/application decisions are explicit in the contract and TASK-0123–0126 handoff plans.
- Contract check preserves all 63 prior UL rows and verifies 12 deterministic contract groups; focused formatting and diff checks pass.

## Non-goals

Implementation, direct messages, threads, reactions/likes, ratings, moderation roles, private posts, task management, automatic prompt injection, automatic truth checking, or cross-machine synchronization.
