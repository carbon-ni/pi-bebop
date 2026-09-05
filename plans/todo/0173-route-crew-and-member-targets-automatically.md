---
id: TASK-0173
title: Route Crew and Member targets automatically
status: todo
depends_on: [TASK-0172]
priority: high
tags: [crew, member, routing, identity, privacy, deterministic, tdd]
---

# Route Crew and Member targets automatically

## Problem

Even after a user knows a Crew and Member name, current commands require choosing a source Pi session. Bebop must resolve transport internally without silently borrowing another Member identity and must handle ambiguity deterministically.

## User story

As a Crew coordinator, I want to supply `crew` or `crew/member` so that Bebop selects a valid trusted route and product errors never ask me to choose a session or socket.

## Acceptance criteria

- [ ] One application-level resolver accepts the TASK-0171 Crew/Member target and returns either one authorized route or one typed product error; CLI handlers do not select sessions themselves.
- [ ] Exact Crew selector and exact Member name route deterministically across zero, one, or multiple live local candidates; duplicate selector/worktree matches require an explicit trusted Crew Locator.
- [ ] Duplicate display names, unknown Crew, unknown Member, ambiguous Member, unjoined Crew, offline target, stale route, and malformed peer state produce distinct actionable errors.
- [ ] Routing preserves the caller's current joined Member or approved Guest identity. It never selects an arbitrary joined Member as source; self-target is a typed product error unless the caller has a separate authorized Guest route.
- [ ] Crew-level targets resolve only to the manifest-authored Crew contact where that action permits it; no lead/role/first-online fallback is inferred.
- [ ] Authorization, Crew membership, Guest capability boundaries, and action-specific permissions are checked before transport. Crew Locator access alone grants none of them.
- [ ] Selection order is deterministic and independent of directory iteration, probe completion, alias order, or wall-clock races.
- [ ] Public success/error objects contain product identities only. Session IDs and sockets remain internal except in explicit routing diagnostics.
- [ ] Resolution and action deadlines are separate, bounded, cancellable, and documented; timeout errors include the failed phase and a safe retry command.
- [ ] Unit and integration tests cover all state-table paths, same-boundary races, no dependency call after ambiguity, and no private identifier leakage.

## Non-goals

Load balancing, availability claims, role-based authority, automatic reassignment, message fan-out, or changing delivery semantics.
