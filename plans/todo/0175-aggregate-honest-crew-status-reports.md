---
id: TASK-0175
title: Aggregate honest Crew status reports
status: todo
depends_on: [TASK-0174]
priority: high
tags: [cli, crew, status, report, provenance, freshness, tdd]
---

# Aggregate honest Crew status reports

## Problem

Mechanical Presence does not answer what a Crew is trying to achieve, who owns work, what progressed, or what is blocked. Users need one Crew-level report that combines clearly separated mechanical evidence and explicit Member-reported work state without inference.

## User story

As a Crew coordinator, I want `pi-bebop crew status <crew>` to give an honest bounded report so that I can see goal, assignments, progress, blockers, results, and next step without contacting every Member manually.

## Acceptance criteria

- [ ] `pi-bebop crew status <crew-selector>` resolves the Crew without caller-supplied session/socket data and reports Members in manifest order.
- [ ] The output separates `Mechanical` facts (Presence, Activity, pending signal, observed time) from `Member-reported` goal/assignment/progress/blockers/results/next-step fields.
- [ ] Reported fields come only from explicit structured Member Responses defined by TASK-0171. Bebop never infers them from Activity, conversation, tools, Git, plans, role, or silence.
- [ ] Each invocation is an explicit active refresh: after authorized Crew resolution, it sends at most one bounded non-interrupting structured report request to each eligible online configured Member and performs no request for offline/ineligible Members. Help and output state that the command may trigger Member turns.
- [ ] Per-Member delivery/Response deadlines and one whole-command deadline are finite, separately configured within TASK-0171 bounds, and cancellation stops outstanding waits without claiming remote rollback.
- [ ] Current status never silently falls back to persisted/history data. A missing, declined, malformed, offline, or timed-out current Response renders that Member's reported fields unavailable; historical reports are available only through TASK-0176's explicit history view.
- [ ] Authorization is checked once against the selected Crew and again per Member/action before any request; partial authorization is explicit and no unauthorized Member receives a prompt.
- [ ] Every field carries source Member and reported/observed time or is explicitly unavailable; age is frozen evidence and is never automatically labelled stale.
- [ ] Offline, timed-out, malformed, declined, and partial Member reports remain visible per Member without failing or fabricating the whole Crew report.
- [ ] Crew-level goal/conflict aggregation follows the approved provenance rule; conflicting Member reports are shown, not silently reconciled.
- [ ] Collection is concurrent where safe, bounded by documented per-Member and whole-command deadlines, cancellable, and deterministic despite completion order.
- [ ] Default output contains no message transcript, hidden instructions, session IDs, sockets, Request IDs, capabilities, or raw dependency errors.
- [ ] TOON, text, and JSON contain equivalent bounded decision-relevant data; text has clear headings and TOON round-trips to the canonical result.
- [ ] Errors include corrected commands for unknown/duplicate Crew names and distinguish no reachable Members from no reported progress.
- [ ] Tests cover full, partial, empty, conflicting, offline, timeout, cancellation, malformed, duplicate-Crew, and private-data paths with deterministic clocks.

## Non-goals

Continuous monitoring, productivity scoring, autonomous task management, transcript summarization, or claiming that reported progress is verified completion.
