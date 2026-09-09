---
id: TASK-0201
title: Capture online Member Pi Sessions
status: todo
depends_on: [TASK-0200]
priority: high
tags: [crew, session, capture, cli, rpc, persistence, security, tdd]
---

# Capture online Member Pi Sessions

## Problem

The Crew Session contract needs a trustworthy way to bind configured Members to the exact persistent Pi conversations currently running. Inspecting alias targets or guessing session files is incomplete, especially with custom session directories, and generic Member Status intentionally hides private session identifiers.

## Desired outcome

Add one explicit capture flow that queries each configured Member through its trusted local endpoint, validates the returned Pi Session binding, and atomically stores a complete or honest partial Crew Session record in private machine-local state.

## Target command

```text
pi-bebop crew session capture <name> [--crew <locator>] [--format toon|json|text]
pi-bebop crew session add <crew-session-id> <member> [--format toon|json|text]
```

The command defaults to the canonical Crew in current trusted project. It does not prompt, launch Pi, or require all Members online.

## Acceptance criteria

- [ ] Argument validation completes before manifest, socket, session, or storage IO; unknown/duplicate/missing flags return usage error exit 2.
- [ ] Capture resolves one exact trusted Crew Locator and queries Members in manifest order with bounded per-member and total deadlines.
- [ ] Before implementation, a focused compatibility test pins the supported `@earendil-works/pi-coding-agent` version and proves public `ExtensionContext.sessionManager` supplies full session ID, persisted file, cwd, and session root, and that supported `SessionManager.open`/header APIs validate the binding. If any field lacks a stable public source, implementation stops and adds an explicit Pi integration dependency instead of parsing private JSONL assumptions.
- [ ] Purpose-specific local capture RPC attests only the active Pi session's current configured Member identity, full Pi Session ID, persisted session file, session cwd/root, and Membership evidence from those public APIs; generic status/roster/message APIs remain unchanged and private.
- [ ] Capture validates RPC identity against trusted manifest Member name, role, configured endpoint, Crew Locator, and current active Membership; mismatch is a per-member failure, never accepted attribution.
- [ ] Ephemeral Pi sessions are `unpersisted-session` and cannot create a resumable link.
- [ ] Session validation uses supported `SessionManager.open`/header APIs, requires a regular non-symlink file beneath the canonical active SessionManager-reported root, and matches full header ID and cwd. It rejects path escape, malformed/unsupported session, wrong ID/root/cwd, directory, device, or unavailable file without reading conversation content.
- [ ] Default and custom session roots are canonicalized and accepted only when the active Pi reports them, the file is a descendant, current user owns root/file where POSIX ownership exists, and no path component is symlinked or group/world-writable. Missing/untrusted custom roots fail `untrusted-session-root`; no default-root fallback or whole-home scan occurs.
- [ ] Crew Session storage uses the TASK-0200 machine-local `0700` directory/`0600` record policy with current-user ownership and symlink rejection. No Guest, Principal, external Intake, model tool, or message payload can invoke capture RPC or receive Pi Session references.
- [ ] Capture records complete/partial state plus a reason for every configured Member; offline/unavailable members never block recording valid links when at least one link succeeds. Zero valid links returns `capture-empty`, exits 1, and leaves no record.
- [ ] New record publication uses private parent directory, restrictive file mode, same-directory staging, atomic rename, fsync where supported, and cleanup on failure.
- [ ] Name collisions return matching bounded IDs and require exact ID; exact repeated capture is an unchanged success, while conflicting Member binding returns `member-already-bound` and never overwrites. Replacement is deferred; user creates a new Crew Session when a different binding is intended.
- [ ] `crew session add <id> <member>` requires exact stable Crew Session ID and exact configured Member name, captures that Member through same validation path, and atomically fills only a missing link. Exact repeat is unchanged; another Member or existing binding is untouched.
- [ ] Adding a missing Member is atomic and cannot alter other bindings. Concurrent capture/add operations serialize or reject deterministically without lost updates.
- [ ] Default TOON reports Crew Session ID/name, Crew, complete/partial state, captured count, missing Member reasons, and next `show` command without exposing raw dependency errors.
- [ ] Exit 0 means record created/unchanged/extended with at least one valid link, exit 1 means operational failure or `capture-empty`, and exit 2 means usage error; partial capture is exit 0 with explicit `partial: true`.
- [ ] Tests cover complete, partial, all unavailable, offline, ephemeral, wrong Crew/Member, custom session directory, malformed header, symlink/path escape, collision, idempotency, concurrent update, timeout, interrupt, atomic cleanup, redaction, and TOON/JSON/text parity.

## Non-goals

Listing historical Crew Sessions, generating resume commands, starting Pi, reading conversation messages, modifying Pi session files, automatic capture on shutdown, or remote/network capture.
