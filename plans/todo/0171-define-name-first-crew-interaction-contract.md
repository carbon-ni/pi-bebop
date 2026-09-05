---
id: TASK-0171
title: Define name-first Crew interaction contract
status: doing
depends_on: []
priority: high
tags: [product, crew, routing, ask, status, privacy, ubiquitous-language]
---

# Define name-first Crew interaction contract

## Problem

Crew users currently need session IDs, socket paths, source-session selection, and multi-step Request IDs to reach people. Product semantics for public Crew targets, ambiguity, automatic routing, synchronous questions, progress truth, freshness, and privacy must be explicit before implementation.

## User story

As a user coordinating Crews, I want to address a Crew or Member by product identity so that Pi Bebop handles transport and I can ask questions without learning sessions, sockets, or correlation internals.

## Target experience

```text
pi-bebop crew list
pi-bebop crew status funzzy
pi-bebop ask funzzy "What are you working on?"
pi-bebop ask funzzy/Mony "What is blocked?"
```

## Decisions this contract must make

- Public Crew selector versus display name, including duplicate display names and renamed Crews.
- Exact `crew` and `crew/member` target grammar, escaping, case sensitivity, limits, and ambiguity errors.
- Meaning of Crew-level `ask`: use the explicit Crew contact or fail with a corrected Member-target command; never infer lead/first/online authority.
- Which trusted local Crew memberships are discoverable and eligible to route an action.
- Deterministic routing when zero, one, or multiple local Pi sessions can represent the same Crew, including contacting a Member hosted by the selected source session.
- Default and allowed timeout bounds for discovery, delivery, post-idle Response grace, and total synchronous wait.
- Provenance for Crew goal, assignments, progress, blockers, results, and next step. Mechanical Presence/Activity must stay distinct from explicit Member-reported work state.
- Freshness timestamps, partial results, history retention, privacy/redaction, and opt-in transport diagnostics.

## Acceptance criteria

- [ ] `UL.md` defines Crew directory, Crew target, Member target, Ask, Crew report, Reported work state, and Routing diagnostic without conflating Member identity with Pi session transport.
- [ ] A state table covers missing/duplicate Crew names, exact selector, missing/duplicate Member name, offline Crew/Member, self-target, stale route, timeout, partial Response, malformed Response, and cancellation.
- [ ] Crew-level Ask routing uses only manifest-authored Crew contact policy; absence is actionable and never guessed.
- [ ] Crew Status field-by-field provenance states whether each value is manifest-authored, mechanically observed, or explicitly Member-reported, with timestamp and unavailable behavior.
- [ ] The contract forbids inference from conversation history, tool activity, Git, plans, role, or idle state.
- [ ] Session IDs, runtime sockets, Member endpoints, Request IDs, and capabilities are absent from default text/TOON/JSON unless an explicit diagnostic mode permits a safe subset.
- [ ] Timeout defaults, minimums, maximums, terminal outcomes, and retry hints are documented in human terms.
- [ ] Errors name the ambiguous/missing product target and include a corrected runnable command when possible.
- [ ] Success metric: each target example above is one non-interactive command and requires zero caller-visible routing or correlation identifiers.
- [ ] Security, product, development, and QA review approve the contract before implementation tasks start.

## Non-goals

Implementation, permission inference from roles, transcript summarization, autonomous task management, continuous monitoring, or claiming that a Response proves work completion.

## Source feedback

Captured 2026-09-05 from a Crew coordinator after direct use. Highest-value request: “I talk to a Crew; Pi Bebop handles transport.”
