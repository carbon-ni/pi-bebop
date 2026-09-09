---
id: TASK-0200
title: Define durable Crew Session links
status: todo
depends_on: []
priority: high
tags: [product, crew, session, resume, identity, persistence, privacy, ubiquitous-language]
---

# Define durable Crew Session links

## Problem

Pi can reopen one exact conversation with `pi --session <path|id>`, and a resumed Pi session can restore its persisted Bebop membership. After every Crew Member process closes, however, there is no durable product concept that says which exact Pi sessions worked together. A user must remember or rediscover each conversation independently, and choosing each Member's latest session can reconnect unrelated work.

## Desired outcome

Define a **Crew Session** as an explicit, named, machine-local link between one Crew and one exact persisted Pi session for each captured Member. The user captures the currently online Crew once, then later inspects the link and reopens Members one by one. Bebop does not launch the whole Crew or infer relationships from timestamps.

## Target experience

```text
# While the intended Member sessions are online
pi-bebop crew session capture "auth regression"

# After every process/tab has closed
pi-bebop crew session list
pi-bebop crew session show <crew-session>
pi-bebop crew session resolve <crew-session> <member>
# user runs the returned exact Pi command in a chosen terminal
```

## Core contract

- **Pi Session** remains Pi's persisted JSONL conversation with an exact full session ID, file, and working directory.
- **Crew Session** is a local bookmark/snapshot that groups exact Pi Sessions by configured Member. It is not a shared conversation, running process group, workflow, task, or liveness claim.
- **Crew Session capture** explicitly snapshots currently joined online Members. It never guesses from recent sessions, names, timestamps, branches, roles, or message content.
- **Member Session link** binds Crew identity, exact Member name, and exact full Pi Session identity at capture time.
- **Member Session addition** explicitly captures one currently joined Member into an existing partial Crew Session without changing other links.
- **Member Session resolution** validates one stored link and returns evidence needed to reopen it manually. Resolution never starts Pi.

## Acceptance criteria

- [ ] `UL.md` and maintained documentation define Crew Session, capture, Member Session link, and resolution without overloading Crew, Membership, Pi Session, Presence, or Request outcome.
- [ ] One Crew Session has stable generated ID, non-empty human name, exact Crew Locator/public identity when available, manifest fingerprint, creation time, and manifest-order Member links.
- [ ] Each captured Member link records exact configured Member name/role, full Pi Session ID, persisted session-file reference, session working directory, and capture time; it never stores conversation content, credentials, provider tokens, Inbox content, or Role instruction text.
- [ ] Capture is explicit and observes only currently joined Members belonging to exact Crew; no latest-session or timestamp inference exists.
- [ ] Default capture may be `complete` or `partial`. Offline, unavailable, ephemeral, malformed, wrong-Crew, or unpersisted Members remain named with exact reasons and are never silently omitted.
- [ ] Partial capture is durable and `crew session add <id> <member>` can add one previously missing exact Member later without changing other links. Replacing an existing different binding is deferred; it fails explicitly and requires a new Crew Session capture.
- [ ] A capture with zero valid Member links is `capture-empty`, exits 1, and writes no record. Partial success requires at least one valid link and remains exit 0 with every missing Member reason.
- [ ] Exact recapture of same binding is idempotent. Duplicate Crew Session names require exact ID selection and never choose first/most recent.
- [ ] Records live under a dedicated `crew-sessions/` directory within machine-local Bebop control state, outside repository and manifest. On POSIX, directory creation is `0700`, records are `0600`, current-user ownership is required, and any symlink, foreign owner, or group/world-writable root/record fails closed. Writes use private same-directory staging plus atomic publication and are never added by scaffold behavior.
- [ ] A Pi session file is allowed only beneath the canonical SessionManager-reported session root for that active Pi session. Default and custom roots require canonical descendant checks, current-user ownership, no symlink traversal, and no group/world write; absent or untrusted custom roots fail explicitly without falling back to another root.
- [ ] Closing Pi processes preserves links. Explicit Crew leave, Pi session deletion, manifest drift, moved worktree, or missing file is reported on later inspection; history is not silently rewritten or deleted.
- [ ] A fork/clone cannot become the linked Pi Session merely because it copied extension entries; the link retains captured header/session identity.
- [ ] Reopening the stored Pi Session relies on Pi's supported `--session <path|id>` behavior and existing membership restore. Bebop uses supported Pi SessionManager/session lifecycle contracts rather than private JSONL parsing, and does not copy, parse for context, or reconstruct conversation messages.
- [ ] Normal Crew/member/status/list outputs continue hiding Pi Session IDs/files. Session references appear only on explicit Crew Session commands and remain bounded.
- [ ] Contract states that session resolution is an observation, not a lock: it cannot guarantee another process will not open the file before the user runs the command.
- [ ] CLI defaults are TOON with deterministic text/JSON alternatives, explicit empty/partial/stale states, and stable exit semantics.
- [ ] No dependency on Crew directory/routing TASK-0172 is required when exact current-project Crew Locator is used; public Crew selectors may be added later without changing link identity.

## Non-goals

Launching terminals, resuming the whole Crew, background agents, copying/exporting conversations, cloud synchronization, cross-user sharing, selecting a recent session automatically, task tracking, or changing Pi's JSONL/session semantics.
