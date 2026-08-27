---
id: TASK-0110
title: Verify and document the Crew Agreements lifecycle
status: todo
depends_on: [TASK-0106, TASK-0107, TASK-0108, TASK-0109]
priority: high
tags: [crew-agreements, verification, documentation, security, determinism]
---

# Verify and document the Crew Agreements lifecycle

## Problem
Without executable end-to-end evidence and clear operator guidance, the Crew could claim agreements are shared or activated while Members hold different revisions, reminders duplicate, or proposal content crosses the instruction boundary.

## Context
Final product gate for the complete manual and cadence-assisted lifecycle.

## Acceptance criteria
- [ ] Executable matrix proves proposal → manual Crew Retrospective → candidate revision → explicit activation → next-Membership snapshot → Crew Broadcast announcement.
- [ ] At least two Members load byte-identical Current Crew Agreements while retaining distinct Role instructions; active snapshots never hot-reload.
- [ ] Failure matrix proves no Role/Origin/facilitator/message can activate, all validation failures write zero target state, and conflicts/restarts remain deterministic.
- [ ] Cadence matrix proves one reminder only, offline durable handoff, no automatic start, no fallback facilitator, and injected-clock boundary behavior.
- [ ] Template matrix proves initial Agreement adoption/provenance without importing proposals or retrospective history.
- [ ] `UL.md`, README, architecture docs, CLI/tool affordances, manifest examples, and recovery guidance use only canonical `crew-agreements` language.
- [ ] Focused coverage, packaging, typecheck/lint, architecture gate, full `make all` watcher gate, and clean-worktree evidence pass.
- [ ] Acceptance report records exact commit, watcher generation, executable counts, and remaining non-goals.

## Non-goals
Release publication or implementation of deferred consensus/automation policies.

