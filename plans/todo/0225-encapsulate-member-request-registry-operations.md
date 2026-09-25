---
id: TASK-0225
title: Encapsulate Member Request registry operations
status: doing
depends_on: [TASK-0223]
priority: high
tags: [refactor, application, member-request, coupling, tdd]
---

# Encapsulate Member Request registry operations

## Problem

`MemberRequestFlow` exposes its mutable registry. `src/pi/control-runtime/member-request-handlers.ts` invokes failure transitions and builds ordered request lists from registry internals. Adapter code therefore owns workflow details that must change alongside the coordinator.

## Deliverable

Semantic request-flow operations for pre-acceptance failure and ordered request summaries; production callers do not reach through the flow to manipulate its registry.

## Scope and approach

- Inventory production registry consumers before changing visibility.
- Characterize list ordering, direction filters, failure outcomes, and acceptance ordering.
- Move summary assembly and ordering into the flow. Expose the smallest operations needed by callers; keep pure registry decisions in domain.
- Migrate affected callers and make the registry private once no production consumer needs direct access.

## Acceptance criteria

- [ ] Request handlers call flow operations rather than registry transitions or summary internals.
- [ ] Summary order, direction filters, response shapes, and failure codes remain unchanged.
- [ ] Tests cover failure before acceptance, successful acceptance, unknown requests, and disconnect cleanup.
- [ ] Registration still precedes model visibility; failure, idle settlement, timers, and channel cleanup retain their behavior.
- [ ] Existing domain registry tests remain meaningful; focused coverage and fresh watcher final gate pass.

## Non-goals

Rewriting the request state machine, changing Member/Guest permissions, new retry policy, or changing delivery guarantees. Coordinate with ongoing TASK-0217 if implementation overlaps its files; it is not an assumed semantic prerequisite.
