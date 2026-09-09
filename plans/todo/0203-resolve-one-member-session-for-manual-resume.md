---
id: TASK-0203
title: Resolve one Member Session for manual resume
status: todo
depends_on: [TASK-0202]
priority: high
tags: [crew, session, resume, cli, pi, safety, integration, tdd]
---

# Resolve one Member Session for manual resume

## Problem

A user can inspect a Crew Session but still needs one exact, safe, copyable way to reopen the Pi conversation for a selected configured Member. Hand-building commands from private paths risks choosing the wrong session, wrong cwd, an inactive membership branch, or a session already open elsewhere.

## Desired outcome

Resolve one Crew Session plus exact Member into a validated Pi startup specification and human copyable command. The command does not execute it. When the user runs it, Pi opens the exact stored JSONL and Bebop revalidates/restores that session's persisted Membership through existing lifecycle behavior.

## Target command

```text
pi-bebop crew session resolve <crew-session-id> <member> [--format toon|json|text]
```

## Acceptance criteria

- [ ] Resolution requires stable exact Crew Session ID and exact case-sensitive Member name; Role, display name, fuzzy text, first Member, and most recent session never select a target.
- [ ] Success revalidates record, trusted Crew, Member identity, stored full session ID, canonical SessionManager-reported root, regular session file/header through supported Pi APIs, cwd, persisted active Membership entry, and observed process state before returning startup data.
- [ ] Structured output returns argument vector and cwd as separate fields, not an interpolated shell command; text output provides one correctly shell-escaped copyable command.
- [ ] Startup specification uses Pi's supported exact `--session <absolute-file>` behavior. It does not add `--crew-role`/`--crew-socket`, replace model/thinking settings, rename session, fork, clone, or inject a prompt.
- [ ] `already-open` refuses a normal resume command and explains that opening one JSONL in two writers is unsafe. Stale/unreachable observation remains qualified and never claims a lock or race-free guarantee.
- [ ] Missing file/cwd, wrong header/session ID, ambiguous exact-ID recovery, inactive membership, manifest/member/endpoint drift, untrusted project, incompatible session version, and corrupt record each return a stable failure with one safe recovery.
- [ ] If stored path moved, optional exact full-ID recovery searches only recorded, currently trusted Pi session roots, accepts exactly one supported SessionManager/header match, and requires explicit record repair; absent/untrusted roots and zero/multiple matches never guess or fall back to whole-home scanning.
- [ ] Resolution never reads conversation messages beyond supported metadata/membership state required for validation, never writes session JSONL, and never starts a process or terminal.
- [ ] Compatibility/integration evidence pins the supported Pi package version and proves two boundaries separately: Pi reopens the exact same persisted Session ID/file through supported `--session`/SessionManager behavior; then Bebop independently reads its branch-aware Membership entry, revalidates trusted manifest/endpoint, and restores same configured Member context.
- [ ] Model and thinking values are observed only to confirm that Pi remains their owner; Bebop does not promise, copy, override, or repair them.
- [ ] Integration tests cover process restart, explicit prior Crew leave, fork/clone copied entries not stealing binding, manifest change, endpoint claim conflict, deleted/imported session, untrusted custom session root, and concurrent-open refusal.
- [ ] README/session workflow explains capture-before-shutdown, list/show, one-Member resolution, manual command execution, partial capture recovery, and limitations.
- [ ] Packaged CLI verification proves commands work outside repository checkout with default/custom Pi session directories and never require the user to inspect JSONL manually.

## Non-goals

Executing the returned command, opening terminal tabs/tmux, whole-Crew resume, background processes, automatically repairing records, session locking inside Pi core, importing/exporting conversations, or cloud synchronization.
