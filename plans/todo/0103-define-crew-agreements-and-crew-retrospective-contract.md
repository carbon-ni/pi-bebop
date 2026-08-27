---
id: TASK-0103
title: Define Crew Agreements and Crew Retrospective contract
status: doing
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
- [x] `UL.md` defines Crew Agreement, Current Crew Agreements, Agreement proposal, Agreement revision, Agreement activation, Agreement activation notice, Trial Agreement, Crew Retrospective, Retrospective facilitator, Retrospective evidence, Member retrospective report, Retrospective situation, and Crew Retrospective Record.
- [x] Relationships define Crew work → Retrospective evidence → evidence-backed situation → interpretation → Agreement proposal → revision → activation → current snapshot, and distinguish retrospective due/open/completed states.
- [x] Trigger ownership is explicit: Bebop detects due, exact configured Member starts/co-ordinates, trusted project operation activates.
- [x] `Accepted`, Response, Role, Origin, Crew Broadcast, Inbox, and Member request retain current canonical meanings; Role and Origin never grant activation authority, and an operator-produced Agreement activation notice is explicitly not Crew Broadcast.
- [x] Contract makes visible Crew work Crew-readable by default while separating security redaction from privacy: credentials/secrets are removed, hidden model reasoning is unavailable, and visible messages/tool results/artifacts may contribute evidence.
- [x] Evidence, interpretation, and Agreement proposal remain distinct; collected evidence and a Member report never automatically become Current Crew Agreements.
- [x] Contract resolves duplicate start, unavailable facilitator, takeover, missing/late Responses, objection/correction, stale base revision, interval boundaries, evidence arriving after freeze, clock rollback, and restart semantics.
- [x] Product contract states what is deliberately deferred: automatic start, Crew-consensus activation, hot reload, registry, semantic conflict resolution, and unbounded raw transcript dumps.

## Notes
Problem and outcome first; implementation tasks must depend on this contract rather than inventing vocabulary locally.

Delivery claim (awaiting independent acceptance):
- Contract: `docs/CREW-AGREEMENTS.md`.
- Canonical language: `UL.md`.
- Evidence report: `.tmp/reports/27-08-26/task-0103-crew-agreements-contract.md`.

