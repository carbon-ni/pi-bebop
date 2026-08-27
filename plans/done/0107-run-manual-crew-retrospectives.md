---
id: TASK-0107
title: Run manual Crew Retrospectives
status: done
depends_on: [TASK-0104, TASK-0105, TASK-0115]
priority: high
tags: [crew-agreements, retrospective, member-request, coordination, tdd]
---

# Run manual Crew Retrospectives

## Problem
Crew members lack a bounded, recoverable way to review the same evidence-backed situations and current agreements, challenge interpretations, preserve objections or absence, and produce one candidate Agreement revision without ad-hoc chat.

## Context
Manual first: validate the coordination and recovery model before adding cadence reminders.

## Acceptance criteria
- [ ] Crew manifest configures Retrospective facilitator by exact Member name; Role is never inferred as facilitator or authority.
- [ ] Explicit start creates at most one open Crew Retrospective, fixes the exact interval, and snapshots roster, Current Crew Agreements revision, bounded pending proposals, and one immutable Crew Retrospective Record; exact duplicate start is idempotent.
- [ ] Each configured Member receives the same record identity and one Member request covering evidence correction, interpretation challenge, Start/Stop/Continue, current/Trial Agreement review, and objections.
- [ ] Responses correlate through existing Member request semantics; correction never mutates original evidence, and offline, timeout, missing, malformed, and late Responses remain explicit and never imply agreement.
- [ ] Facilitator can synthesize one candidate Agreement revision but cannot activate it through retrospective privileges.
- [ ] Open round survives restart; completion is deterministic; explicit takeover handles unavailable facilitator without Role inference or duplicate requests.
- [ ] Workflow uses Follow-up/Inbox/Member request semantics only—never Redirect or Interrupt—and no background start occurs.
- [ ] Tests cover full/partial participation, disputed interpretation, evidence correction, no-op revision, restart, duplicate start, takeover, stale current revision/record, and activation boundary.

## Non-goals
Cadence, automated meeting summaries, sentiment analysis, or automatic consensus.

