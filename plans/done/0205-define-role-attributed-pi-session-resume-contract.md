---
id: TASK-0205
title: Define role-attributed Pi session resume contract
status: done
depends_on: []
priority: high
tags: [crew, session, resume, identity, persistence, pi, safety, tdd]
---

# Define role-attributed Pi session resume contract

## Problem
A current Crew member cannot safely find its own prior Pi sessions by role because Pi's native picker has no candidate filter and generic JSONL has no durable role attribution.

## Command decision

```text
pi-bebop session resume --role <exact-role>
```

This is a Bebop-owned interactive command. Plain `pi -r` remains Pi-owned and unchanged. The command must select and launch exactly one existing Pi session; it is not a Crew Session resolver and must not print a command as its success outcome.

## Architecture

1. On Member join, Bebop appends versioned, branch-aware membership state that captures immutable Member name/role plus Crew manifest locator and fingerprint, exact Pi session ID/file/cwd/root being Pi-owned metadata.
2. `session resume --role` loads one current-project trusted Crew manifest and resolves the role with the existing exact, unique-role rule. It never chooses a Member from a historical manifest.
3. It discovers only persisted Pi sessions through public `SessionManager.listAll()`/`SessionManager.open()` and reads only the active branch's Bebop membership entry through `getBranch()`. Old or malformed/unattributed/inactive sessions are excluded.
4. A candidate matches only when its active snapshot has the exact current configured Member name/role, canonical current Crew locator, and current manifest fingerprint. Manifest drift is explicit and produces no relabelled result.
5. Before display and again after selection, validate Pi session-file evidence and probe the exact current Member endpoint. Missing/stale/untrusted/malformed/cwd-mismatch/session-ID-mismatch/already-online outcomes must never launch Pi.
6. The picker may use its own TTY UI; cancellation launches nothing. On confirmation it spawns `pi --session <absolute-file>` with inherited stdio and the stored header cwd. It adds no role/socket/model/prompt/fork/clone argument and waits for Pi's exit status.

## Acceptance criteria
- [ ] The command grammar is `pi-bebop session resume --role <exact-role>`; `pi -r` behavior and candidate set are unchanged.
- [ ] Attribution is appended only by joined Bebop lifecycle state, is versioned and immutable per entry, and contains no conversation content, credentials, or role-instruction text.
- [ ] Candidate discovery uses supported Pi `SessionManager` APIs and active-branch extension entries, not raw JSONL parsing, filenames, names, timestamps, prompts, or current-manifest role inference.
- [ ] Current scope requires one validated project-local Crew and one exact unique role. Candidate identity requires exact configured Member name+role, canonical Crew locator, and current manifest fingerprint.
- [ ] Unattributed legacy sessions, inactive memberships, malformed data, manifest drift, and ambiguous/missing roles are excluded with explicit bounded outcomes; there is no fallback to a recent/unrelated session or a new session.
- [ ] Selection revalidates the exact persisted session file/header/root/cwd and refuses an already-online Member endpoint before launch.
- [ ] Confirmation launches exactly `pi --session <absolute-file>` at the stored cwd with inherited terminal streams; it neither creates, forks, clones, reconstructs, renames, nor mutates the selected session.
- [ ] Cancel, empty, stale, validation failure, process launch failure, and child exit are deterministic and leave Pi sessions and Membership state unchanged.
- [ ] The contract distinguishes Role Session Resume from existing explicit Crew Session capture/resolve, whose manual-resolution contract remains unchanged.

## Non-goals

Native Pi picker modification, automatic whole-Crew restore, historical role inference, session repair, cross-user/cloud index, non-TTY picker, or a fallback new session.
