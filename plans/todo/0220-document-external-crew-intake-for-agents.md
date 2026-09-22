---
id: TASK-0220
title: Document external Crew Intake for agents
status: doing
depends_on: [TASK-0216]
priority: high
tags: [intake, docs, agents]
---

# Document external Crew Intake for agents

## Problem

Outside agents can discover the Crew Intake directory but have no local, machine-adjacent instructions for publishing safely. They may write directly, use unsupported files, or mutate internal Inbox and evidence directories. New Crew scaffolds need an Intake-specific `AGENTS.md` that explains the external boundary without changing runtime behavior.

## Desired outcome

`bebop crew init` creates `.pi/bebop/intake/AGENTS.md` as durable guidance for an outside agent. The guide distinguishes external Intake from the internal Inbox and gives one safe atomic publication procedure.

## Acceptance criteria

- [ ] New Crew scaffolds include `.pi/bebop/intake/AGENTS.md` with deterministic LF UTF-8 content.
- [ ] The guide says Intake content is unverified external context and transport does not prove it was read, acted on, or completed.
- [ ] The guide permits only non-empty bounded UTF-8 `.md`/`.txt` direct-child files in `intake/new/`.
- [ ] The guide instructs writers to finish a temporary `.draft`, close/fsync it, then atomically rename it into `new/`.
- [ ] The guide forbids modifying `processed/`, `failed/`, receipts, commits, locks, sockets, or `.pi/bebop/inbox/`.
- [ ] The guide tells agents to use unique filenames and inspect file movement for transport evidence without inferring semantic completion.
- [ ] The file is outside `intake/new/`, so the watcher never consumes it.
- [ ] Exact reruns remain no-op; conflicting user content remains untouched and fails atomically with the existing managed-file conflict behavior.
- [ ] The disposable Intake smoke Crew contains the same guide so the visible demo matches a newly initialized Crew.

## Non-goals

Teaching internal Inbox storage, authorizing arbitrary files, creating a remote API, changing runtime delivery semantics, or replacing Crew common/Role instructions.
