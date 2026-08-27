---
id: TASK-0114
title: Collect Member session reports for retrospectives
status: todo
depends_on: [TASK-0111]
priority: high
tags: [crew-agreements, retrospective, evidence, member-request, session, tdd]
---

# Collect Member session reports for retrospectives

## Problem
Repository and transport artifacts cannot explain the situations Members experienced; each Member needs a bounded way to report from their visible Crew-session work without relying on facilitator memory.

## Context
Each Member can interpret their own visible Crew-session work. Collection uses existing correlated Member request semantics rather than cross-session impersonation or facilitator memory.

## Acceptance criteria
- [ ] One bounded Member request asks each exact configured Member to review visible Crew-session work in the fixed interval and return one structured Member retrospective report.
- [ ] Report schema distinguishes observed situations, impact, what helped, friction/rework, changed decisions, missing context, and evidence references; no Agreement proposal is required.
- [ ] Member identity is derived from Membership/request context; Role, claimed Origin, or report text cannot impersonate another contributor or grant authority.
- [ ] Visible messages, tool calls/results, and artifacts are Crew-readable inputs; credentials/secrets are redacted and hidden model reasoning is explicitly unavailable, not summarized.
- [ ] Offline, timeout, idle-without-Response, malformed, oversized, duplicate, late, and member-restarted outcomes remain explicit and never fabricate a report.
- [ ] Retry/resume is idempotent by retrospective/member/interval; one accepted report cannot be silently replaced by a later conflicting Response.
- [ ] Reports become Retrospective evidence with attribution and interpretation labels; they never activate or automatically propose Agreements.
- [ ] Tests cover full/partial roster, every Request outcome, redaction, validation, duplicate/late Response, restart, stable IDs, and no cross-member leakage.

## Non-goals
Hidden reasoning access, sentiment/productivity scoring, facilitator-authored reports for absent Members, or direct Agreement activation.

