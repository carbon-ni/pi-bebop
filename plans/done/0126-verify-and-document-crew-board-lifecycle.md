---
id: TASK-0126
title: Verify and document Crew Board lifecycle
status: done
depends_on: [TASK-0125]
priority: high
tags: [crew, board, verification, integration, concurrency, security, documentation]
---

# Verify and document Crew Board lifecycle

## Problem

A shared append-only board can silently lose concurrent posts, leak secrets, drift between agent and human surfaces, or be mistaken for messaging, ratings, and authority without adversarial lifecycle verification and clear guidance.

## Verification plan

1. Build an independent requirement-to-fixture matrix across TASK-0122–TASK-0125 before accepting implementation.
2. Exercise domain/store races with deterministic barriers and real multi-Member integration across both trusted layouts.
3. Prove Pi Membership/tool/command lifecycle and zero message/provider side effects at real composition boundaries.
4. Document concise use, distinctions, storage/recovery, and safe promotion of useful posts.

## Acceptance criteria

- [ ] Independent matrix maps every upstream criterion to executable evidence; prose/keyword presence alone cannot pass.
- [ ] Lead, developer, quality, and product Members join the same Crew and each reads/appends the same Board with identical capability despite different Roles.
- [ ] Concurrent multi-process appends under forced completion orders retain every accepted post exactly once with stable sequence/output; exact retries deduplicate and conflicting retries cannot overwrite.
- [ ] Crash before/after publish, stale temp/lock, lock contention/timeout, capacity, malformed/oversized/tampered file, quarantine failure, permission loss, symlink/traversal, restart, reload, and shutdown are bounded and honest. Stale locks are never age/PID-stolen; tests/documentation cover explicit trusted maintenance and prove no live owner's state is removed.
- [ ] Canonical `.pi/bebop` and compatibility `.pi/crew` layouts work independently, including external project roots; no mirroring/cross-layout merge or per-Member board exists.
- [ ] Join/restore/rejoin grants identical read+append operations; leave/removal/inactive Membership removes them. Role/contact/facilitator/Lead/Origin/kind never changes access.
- [ ] Agent tools and slash commands produce the same canonical append/read outcomes for identical inputs and store state.
- [ ] Instrumented Pi host proves append/read generate zero Follow-up, Inbox, Broadcast, Request/Response, Redirect, Interrupt, provider/model-turn, task, Agreement, and automatic Crew Post content side effects.
- [ ] Fresh join, restore, rejoin, leave, and prompt-rebuild fixtures prove every Current Member sees exactly one bounded Board affordance while no Post count/body/reference/cursor is loaded automatically.
- [ ] Human join/help fixtures teach `/crew board` and `/crew post` once; merely joining or opening help performs zero Board read and no provider call.
- [ ] Reading is repeatable and non-consuming; no read receipt, acknowledgement, recipient, delivery, notification, or per-Member cursor is persisted.
- [ ] Kind matrix proves tip/kudos/feedback/warning/note affect filtering/rendering only. Feedback/kudos are never aggregated or described as ratings, reputation, sentiment, productivity, or performance.
- [ ] Security/privacy fixtures reject credentials/secrets, unsafe identifiers/references, hidden-reasoning requests, unbounded content, and external anonymous authorship without corrupting healthy posts.
- [ ] Supersedes/disputes preserve original bytes and provenance; no silent edit, automatic truth decision, workflow transition, or promotion occurs.
- [ ] Documentation distinguishes Board from all message surfaces, plans/tasks, AGENTS.md, Crew Agreements, and Retrospective evidence; includes copyable tool/slash examples, suggested voluntary read/append moments, and recovery guidance.
- [ ] Documentation states runtime Board data is Git-ignored manifest-adjacent local state shared by Crew processes on the same filesystem, not network/cross-machine synchronization.
- [ ] Focused tests, typecheck, formatting, architecture/package checks, coverage/risk gate, clean full hooks, and fresh watcher verification pass with unchanged-worktree proof.

## Non-goals

Automatic Retrospective collection, global/cross-project Board, network replication, task management, notification service, ratings/reactions, moderation, search service, or automatic documentation/Agreement promotion.
