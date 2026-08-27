---
id: TASK-0104
title: Load Current Crew Agreements for every Member
status: doing
depends_on: [TASK-0103, TASK-0095]
priority: high
tags: [crew-agreements, membership, instructions, manifest, tdd]
---

# Load Current Crew Agreements for every Member

## Problem
Members cannot receive one exact Crew-evolved collaboration agreement snapshot; duplicating agreements across Role instructions causes drift and makes it unclear which revision governs a Membership.

## Context
Builds on TASK-0095's shared-context composition while keeping common instructions and Current Crew Agreements separate concepts.

## Acceptance criteria
- [ ] Crew manifest may optionally select one Current Crew Agreements Markdown file rooted under the trusted Bebop layout.
- [ ] Every Member receives the same exact Agreement revision, including a Member without Role instructions.
- [ ] System context labels and orders project guidance, Common Crew instructions, Current Crew Agreements, and Role instructions without claiming override semantics.
- [ ] Join, restore, and repeated prompt hooks load one stable snapshot and never duplicate sections; edits do not hot-reload an active Membership.
- [ ] Missing, blank, oversized, invalid UTF-8, NUL-containing, directory, symlink-escaped, unreadable, or concurrently changed files fail closed before Membership claim.
- [ ] A Crew without agreements preserves existing behavior; Agreement content never leaks through Presence, Member Status, roster, ordinary tools, logs, or message payloads.
- [ ] Happy/unhappy tests cover parsing, loading, snapshot lifecycle, prompt composition, packaging, and backward compatibility.

## Non-goals
Agreement proposal, activation, retrospective, cadence, or discovery surfaces.

