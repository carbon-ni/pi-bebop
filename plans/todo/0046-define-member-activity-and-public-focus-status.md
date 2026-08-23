---
id: TASK-0046
title: Define member activity and public focus status
status: doing
depends_on: [TASK-0029]
priority: high
tags: [crew, status, activity, focus, ubiquitous-language]
---

# Define member activity and public focus status

## Problem
Presence only proves endpoint reachability; crew members need an honest on-demand view of whether another Pi session is mechanically idle or busy and, when explicitly published, what that member says they are focused on—without inspecting conversation or introducing task tracking.

## Context

Define three separate signals:

- **Presence:** endpoint reachable (`online|offline`), already owned by existing observer.
- **Activity:** exact live Pi runtime state (`idle|busy`) plus boolean pending-message signal from `ctx.isIdle()` / `ctx.hasPendingMessages()`.
- **Focus:** optional bounded member-authored crew-visible note with update timestamp, for example `Implementing TASK-0036` or `Investigating inbox recovery`.

“What are they working on?” cannot be inferred reliably from prompts, tools, Git, plans, or session history. Never summarize private conversation. If Focus is absent, return `unspecified`; do not guess from session name or latest message.

Proposed queried shape:

```json
{
  "member": { "name": "Bob", "role": "developer" },
  "presence": "online",
  "activity": "busy",
  "hasPendingMessages": true,
  "focus": "Implementing Inbox enqueue",
  "focusUpdatedAt": "2026-08-23T12:00:00.000Z",
  "observedAt": "2026-08-23T12:03:00.000Z"
}
```

## Acceptance criteria

- [ ] `UL.md` defines Member Status, Activity, and Focus distinctly from Presence, availability, task state, and session content.
- [ ] Activity derives only from live Pi control-flow APIs and is never manually claimed.
- [ ] Focus is explicit opt-in plain text authored by current member, bounded by named byte limit, and marked `unspecified` when absent.
- [ ] Focus is crew-visible and documentation warns not to publish secrets or private prompt content.
- [ ] Query never returns messages, prompts, tool calls/results, filesystem paths, model details, session IDs, aliases, or instructions.
- [ ] Offline member returns presence `offline` and activity/focus `unavailable`; no stale focus is presented as current.
- [ ] Online result includes activity, pending-message boolean, optional focus/update timestamp, and observation timestamp.
- [ ] `busy` means Pi processing/retrying/continuing; `idle` means runtime settled. Neither means available, healthy, productive, or willing to accept work.
- [ ] Focus persists in typed custom session entries across reload/resume for same membership and remains until updated/cleared; member switch does not leak prior member focus.
- [ ] Any joined member may query another configured member; roles grant no extra visibility.
- [ ] Query is one-shot, finite-time, and never triggers/steers/interrupts target agent turn.
- [ ] Domain schema/formatting tests cover idle, busy, pending, unspecified focus, clear/update, offline, stale membership, and privacy exclusions.

## Out of scope

- Conversation summarization, task/Git/plan integration, automatic focus inference, continuous polling/dashboard, productivity monitoring, historical timelines, availability prediction, or external status access.

