---
id: TASK-0105
title: Persist Agreement proposals and revisions
status: todo
depends_on: [TASK-0103]
priority: high
tags: [crew-agreements, domain, persistence, audit, security, tdd]
---

# Persist Agreement proposals and revisions

## Problem
Agreement ideas currently exist only in transient conversation, so evidence is lost, proposals can be confused with current instructions, and amendments or removals have no deterministic audit trail.

## Context
Proposal and revision records are candidates, never active instructions. A Retrospective situation/evidence item may support a proposal but remains a separate immutable record; evidence is not duplicated or silently rewritten as a proposed rule.

## Acceptance criteria
- [ ] Agreement proposal has stable ID, add/amend/remove intent, problem/evidence, proposed observable behavior, and optional target Agreement ID.
- [ ] Member attribution uses canonical Origin semantics and never grants authority; malformed or external proposals cannot become Current Crew Agreements.
- [ ] Agreement revision references one exact base revision and deterministically records included operations, objections, missing Responses, and Trial Agreement state.
- [ ] Proposal and revision writes are atomic, bounded, path-safe, restart-safe, and fail closed on corruption or concurrent change.
- [ ] List/show operations distinguish proposal, candidate revision, activated revision, superseded, and rejected states without exposing unrelated Inbox or session content.
- [ ] Replaying the same semantic operation is idempotent; conflicting reuse of an ID fails with a stable actionable code.
- [ ] Focused tests cover valid history plus invalid schema, stale base, duplicate ID, partial write, concurrency, and provenance failure paths.

## Non-goals
Activation authority, retrospective orchestration, automatic synthesis, or semantic quality scoring.

