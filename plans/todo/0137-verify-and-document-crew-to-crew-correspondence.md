---
id: TASK-0137
title: Verify and document crew-to-crew correspondence
status: doing
depends_on: [TASK-0136]
priority: normal
tags: [crew, messaging, intake, verification, documentation, cross-project]
---

## Problem

A persisted message and a green unit test do not prove that two Crews can conduct an honest asynchronous exchange without leaking live routes or overstating delivery. The public convention needs independent end-to-end evidence and concise operator guidance.

## Acceptance criteria

- [ ] Independent matrix maps every TASK-0136 criterion to executable evidence at one exact commit.
- [ ] Black-box exchange proves Crew A asks through Crew B's absolute Manifest path, B receives claimed Origin + Crew Return Address after offline handoff, B replies with the same tool, and A receives the answer.
- [ ] Both supported layouts work in either source/target direction; unnamed and named Crews behave identically except optional display label.
- [ ] Failure matrix covers unjoined/stale Membership, non-absolute/self/unsupported/unsafe paths, unreadable/invalid Manifest, disabled/unknown contact, malformed/oversized payload, Inbox capacity, lock conflict, and storage failure with zero partial persistence.
- [ ] Privacy inspection proves no session IDs, aliases, sockets, callback routes, hidden/system/Role instructions, credentials, stacks, or automatic filesystem IO from received return addresses.
- [ ] Deterministic restart/offline tests prove persistence without claiming notification, read, Response, completion, availability, or authentication.
- [ ] README and ubiquitous language define Crew Correspondence and Crew Return Address, explain two one-way letter turns with an ask/reply example, and state same-machine, claimed-origin, stale-path, and no-thread limits.
- [ ] CLI `send --crew <path>` documentation remains external/unverified and does not falsely advertise automatic Crew Origin or reply behavior.
- [ ] Focused coverage, typecheck, formatting, lint, architecture/package checks, fresh full watcher gate, and unchanged-worktree proof pass.

## Non-goals

Registry/discovery, short-name addressing, cross-machine transport, automatic Response routing, conversation threads, delivery/read receipts, authentication, encryption, or changing Crew Intake contact policy.
