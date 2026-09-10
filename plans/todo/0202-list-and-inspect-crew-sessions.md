---
id: TASK-0202
title: List and inspect Crew Sessions
status: todo
depends_on: [TASK-0201]
priority: high
tags: [crew, session, discovery, cli, privacy, toon, text, tdd]
---

# List and inspect Crew Sessions

## Problem

Captured links are not useful if users and agents cannot find the right historical Crew Session and see whether every expected Member has a valid stored Pi Session. Listing must remain compact without hiding partial, stale, duplicate-name, or corrupted state.

## Desired outcome

Add read-only list and show commands that identify exact Crew Sessions, revalidate their current local evidence, and make the next Member-specific resolution obvious without launching anything.

## Target commands

```text
pi-bebop session list [--crew <locator>] [--format toon|json|text]
pi-bebop session show <id> [--format toon|json|text]
```

Names are search/display values. `show` uses stable exact ID; a non-unique name returns ambiguity with candidate IDs rather than guessing.

## Acceptance criteria

- [ ] List returns stable ID, name, Crew identity, capture time, captured/expected counts, and derived `complete|partial|stale|invalid` summary in deterministic order.
- [ ] Empty result is explicit and includes copyable `session capture` next step.
- [ ] Default list is bounded and reports total versus returned count plus exact continuation/full-list hint when truncated.
- [ ] Optional exact Crew Locator filter validates trust before reading/filtering and never treats display name as identity.
- [ ] Show returns manifest-order Member rows with captured/missing state, stored Pi Session identity presence, cwd availability, session-file availability, active-process observation, membership/manifest drift, and exact terminal reason.
- [ ] List/show validate record schema and integrity without opening or parsing conversation bodies. Corrupt records are isolated as bounded `invalid` rows instead of hiding all healthy records.
- [ ] A removed/renamed Member, changed configured endpoint, changed Crew identity/fingerprint, missing worktree, missing/moved session file, wrong session header, or already-open session has a distinct deterministic reason.
- [ ] Historical record is never silently migrated to a changed manifest or rebound to a different session. Recovery uses explicit capture or add; replacing an existing Member binding is unavailable in this roadmap.
- [ ] Full Pi Session file paths and IDs are excluded from default list; show reveals them only in explicit structured detail fields needed for later resolution and never prints conversation content.
- [ ] Default TOON plus JSON/text preserve same states and reasons. Human text is concise; errors include one actionable next step.
- [ ] List/show are read-only, perform no socket/session cleanup, touch no mtimes, and do not launch Pi.
- [ ] Tests cover empty, one/many, duplicate names, truncation, filtering, complete/partial/stale/invalid, mixed corrupt/healthy records, deleted session, moved cwd, manifest drift, active observation, redaction, stable order, and packed CLI behavior.

## Non-goals

Launching or switching sessions, fuzzy name selection, repairing records automatically, scanning message content, remote Crew discovery, or replacing Pi's `/resume` picker.
