---
id: TASK-0207
title: Verify role-scoped session resume outcomes
status: doing
depends_on: [TASK-0206]
priority: high
tags: [crew, session, resume, cli, pi, safety, regression, tdd]
---

# Verify role-scoped session resume outcomes

## Problem
A role-scoped resume selector can silently select an unrelated or unsafe session unless success, cancellation, empty, stale, and already-online outcomes are tested end-to-end.

## Context

Verify `pi-bebop session resume --role <exact-role>` against TASK-0205. The proof must distinguish an exact Pi resume from merely producing a command or creating a fresh/forked/reconstructed conversation.

## Acceptance criteria
- [ ] Tests prove only an active exact snapshot matching current trusted Crew locator/fingerprint and exact configured Member name+role becomes a candidate.
- [ ] Tests prove legacy/unattributed, inactive, other-role, other-Crew, ambiguous-role, missing-role, and manifest-drift sessions are excluded without role inference.
- [ ] Tests prove cancellation and empty results launch no child and mutate no session/Membership state.
- [ ] Tests prove selected-session validation rejects missing/corrupt/untrusted/root-or-ID-or-cwd-mismatch evidence and already-online endpoints without launch.
- [ ] Tests prove confirmation launches precisely `pi --session <absolute-file>` with stored cwd, inherited terminal configuration, no shell, and no extra role/socket/prompt/fork/clone arguments.
- [ ] Tests prove plain `pi -r` remains outside Bebop and unchanged.
- [ ] Targeted verification, formatting/type checks, and watcher final gate evidence are recorded; inherited gate failures are isolated from this task.

## Notes

Kelly owns acceptance/failure-path verification after TASK-0206 is complete.
