---
id: TASK-0181
title: Add a task-oriented Crew quickstart
status: todo
depends_on: [TASK-0174, TASK-0179, TASK-0180]
priority: normal
tags: [cli, quickstart, onboarding, crew, ask, docs, tdd]
---

# Add a task-oriented Crew quickstart

## Problem

Command-local examples do not teach the main workflow from Crew discovery through a correlated answer. New users need one integrated, runnable path that uses product identities and explains what the result does and does not prove.

## User story

As a new Crew coordinator, I want `pi-bebop quickstart` to show the shortest working path so that I can discover a Crew, ask a Member, understand the Response, and recover from common setup failures.

## Acceptance criteria

- [ ] `pi-bebop quickstart` presents one ordered workflow: doctor when needed, `crew list`, `ask <crew>[/<member>]`, interpret the correlated Response, and choose the next command.
- [ ] The primary path requires no external `crews.sh`, session listing, session ID, alias, socket, manifest path, Request ID, or separate send/wait command.
- [ ] Examples derive placeholders from canonical CLI vocabulary and remain copyable after replacing visibly marked Crew/Member/question values.
- [ ] The guide explains that a correlated Response belongs to the Ask but does not prove content truth, task completion, availability, or future responsiveness.
- [ ] Duplicate Crew/member, no Crew contact, offline, timeout, incompatible runtime, and empty discovery each link to one corrected runnable command.
- [ ] Core terms are defined at point of use or linked to `help delivery`; internal terms such as source session and steer do not appear in the primary path.
- [ ] The default command is deterministic concise text, does no project/session/filesystem/network IO, prompts for nothing, and exits 0.
- [ ] README getting-started content is generated from the same source or protected by a stale-content check.
- [ ] Registry/help/package tests prove every advertised command exists and the quickstart works from the packed installed CLI.
- [ ] A usability check confirms the discover-to-Ask path takes two operational commands and exposes zero transport/correlation identifiers.

## Non-goals

Interactive setup, automatic Crew creation/join, tutorials for every advanced command, or claiming a Crew has completed work.
