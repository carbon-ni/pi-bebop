---
id: TASK-0206
title: Implement role-scoped Bebop session picker
status: done
depends_on: [TASK-0205]
priority: high
tags: [crew, session, resume, cli, pi, persistence, safety, tdd]
---

# Implement role-scoped Bebop session picker

## Problem
A user needs to select and actually resume one exact role-attributed existing Pi session without exposing unrelated role history, creating a replacement conversation, or changing Member identity.

## Context

Implement the `pi-bebop session resume --role <exact-role>` contract in TASK-0205. Keep the command adaptation in `src/cli/commands/`, candidate orchestration in `src/application/`, durable snapshot parsing/persistence adapters in the owning Pi/infra modules, and pure matching decisions in `src/domain/`.

## Acceptance criteria
- [ ] Joined membership persistence records the required versioned identity snapshot while preserving existing membership restore compatibility.
- [ ] Candidate discovery uses public `SessionManager.listAll()` and `SessionManager.open()` plus `getBranch()` only; it excludes every candidate lacking an active exact snapshot.
- [ ] The command validates current trusted Crew and exact unique role, then displays only matching candidates in a TTY picker with explicit cancel and empty behavior.
- [ ] It revalidates the selected candidate and current endpoint immediately before launch; stale, changed, malformed, untrusted, missing, or already-online entries are refused without a fallback.
- [ ] Confirmation spawns exact `pi --session <absolute-file>` with `cwd` equal to the selected session header cwd, inherited stdio, no shell, and propagated child exit status.
- [ ] Implementation adds no native Pi `-r` interception, no role/socket flags to child Pi, and no automatic whole-Crew resume.
- [ ] Tests cover domain matching, lifecycle attribution, application selection/validation, CLI grammar/TTY behavior/launch specification, and extension compatibility.

## Notes

Dave owns implementation after TASK-0205 is closed.
