---
id: TASK-0103
title: Define Crew Agreements and Crew Retrospective contract
status: todo
depends_on: []
priority: high
tags: [crew-agreements, product, ubiquitous-language, security, determinism]
---

# Define Crew Agreements and Crew Retrospective contract

## Problem
Bebop has no canonical language or lifecycle for Crew-wide agreements, so cadence, coordination, activation authority, and instruction boundaries could be implemented inconsistently or grant authority through Role or message Origin.

## Context
Canonical terms must extend `UL.md` without weakening Bebop's existing distinctions. Brainstorm: `.tmp/reports/27-08-26/crew-working-agreements-brainstorm.md`.

## Acceptance criteria
- [ ] `UL.md` defines Crew Agreement, Current Crew Agreements, Agreement proposal, Agreement revision, Agreement activation, Agreement activation notice, Trial Agreement, Crew Retrospective, and Retrospective facilitator.
- [ ] Relationships define proposal → revision → activation → current snapshot and distinguish retrospective due/open/completed states.
- [ ] Trigger ownership is explicit: Bebop detects due, exact configured Member starts/co-ordinates, trusted project operation activates.
- [ ] `Accepted`, Response, Role, Origin, Crew Broadcast, Inbox, and Member request retain current canonical meanings; Role and Origin never grant activation authority, and an operator-produced Agreement activation notice is explicitly not Crew Broadcast.
- [ ] Contract resolves duplicate start, unavailable facilitator, takeover, missing/late Responses, objection, stale base revision, clock rollback, and restart semantics.
- [ ] Product contract states what is deliberately deferred: automatic start, Crew-consensus activation, hot reload, registry, semantic conflict resolution.

## Notes
Problem and outcome first; implementation tasks must depend on this contract rather than inventing vocabulary locally.

