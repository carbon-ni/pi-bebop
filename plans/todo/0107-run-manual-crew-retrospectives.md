---
id: TASK-0107
title: Run manual Crew Retrospectives
status: todo
depends_on: [TASK-0104, TASK-0105]
priority: high
tags: [crew-agreements, retrospective, member-request, coordination, tdd]
---

# Run manual Crew Retrospectives

## Problem
Crew members lack a bounded, recoverable way to review current agreements, collect each Member's Response, preserve objections or absence, and produce one candidate Agreement revision without ad-hoc chat.

## Context
Manual first: validate the coordination and recovery model before adding cadence reminders.

## Acceptance criteria
- [ ] Crew manifest configures Retrospective facilitator by exact Member name; Role is never inferred as facilitator or authority.
- [ ] Explicit start creates at most one open Crew Retrospective and snapshots roster, Current Crew Agreements revision, and bounded pending proposals; exact duplicate start is idempotent.
- [ ] Each configured Member receives one Member request covering Start/Stop/Continue, current/Trial Agreement review, evidence, and objections.
- [ ] Responses correlate through existing Member request semantics; offline, timeout, missing, malformed, and late Responses remain explicit and never imply agreement.
- [ ] Facilitator can synthesize one candidate Agreement revision but cannot activate it through retrospective privileges.
- [ ] Open round survives restart; completion is deterministic; explicit takeover handles unavailable facilitator without Role inference or duplicate requests.
- [ ] Workflow uses Follow-up/Inbox/Member request semantics only—never Redirect or Interrupt—and no background start occurs.
- [ ] Tests cover full/partial participation, objection, no-op revision, restart, duplicate start, takeover, stale current revision, and activation boundary.

## Non-goals
Cadence, automated meeting summaries, sentiment analysis, or automatic consensus.

