---
id: TASK-0013
title: Persist and inject crew member identity
status: done
depends_on: [TASK-0009, TASK-0010, TASK-0011]
priority: high
tags: [intray, crew, context, session]
---

# Persist and inject crew member identity

## Problem
Claiming a socket is insufficient if future agent turns do not know their role, crew, and available members, or if reload silently forgets runtime membership.

## Context
Use Pi session state for remembered selection and `before_agent_start` for concise current role context. Do not rewrite prior conversation or silently rename session.

## Acceptance criteria
- [x] Tests cover runtime join, leave, reload restore, resume/fork behavior, unavailable restore endpoint, role switching, and both returned and thrown shutdown release failures through lifecycle seams.
- [x] Join/leave append branch-aware extension state so latest membership can be reconstructed on `session_start`.
- [x] Restore validates trusted manifest, ensures the base server without enabling legacy peer listening, and reclaims endpoint; failure remains explicit without partial identity.
- [x] `before_agent_start` adds current member, role instructions, crew path, and member names exactly once per system prompt.
- [x] Runtime transition adds one visible non-triggering identity message for current conversation.
- [x] Leaving removes future role context and records that identity is no longer active.
- [x] Session `/name` remains independent from intray member identity.
