---
id: TASK-0141
title: Adopt risk-based exact-head acceptance protocol
status: todo
depends_on: [TASK-0140]
priority: high
tags: [collaboration, qa, process, retrospective]
---

# Adopt risk-based exact-head acceptance protocol

## Problem
High-risk cross-cutting work repeatedly lost time to late evidence requirements, superseded or dirty QA candidates, underspecified compatibility boundaries, and verdicts that were difficult to retrieve. The Crew needs a lightweight protocol that makes risk and acceptance evidence explicit without burdening ordinary changes.

## Context

The interim TASK-0140 retrospective found broad agreement across Product, Lead, Development, and QA. Explicit ownership, exact-SHA review, clean-worktree checks, watcher generations, and independent QA prevented premature acceptance. Rework came from discovering the executable failure matrix late, reviewing superseded candidates, underspecifying response compatibility, and relying on outcomes that were hard to retrieve.

This protocol is risk-triggered. It must help high-risk lifecycle, durability, security, or cross-surface work without becoming mandatory paperwork for ordinary changes or early exploration.

## Acceptance criteria

- [ ] Define a bounded trigger for using this protocol. Exploration can start with unknowns, but implementation expansion cannot begin until changed contracts and directly affected dependency boundaries are identified.
- [ ] Provide a risk-ranked template no longer than one page. Each row has a stable criterion ID, affected path and dependency boundary, risk, owner, evidence command or fixture, evidence location, and explicit pass rule.
- [ ] Compatibility rows specify exact bytes or text where locked, error code, visibility, turn/no-turn behavior, delivery disposition, and at least one unchanged-path regression.
- [ ] High-risk host, failure, abort, restart, reconfiguration, crash, race, privacy, and capacity probes are assigned before the final gate. Unit or broad green tests cannot substitute for required real-host evidence.
- [ ] Candidate freeze records the full SHA, clean worktree fingerprint, watcher generation/fingerprint, and matrix delta. Any edit invalidates the QA round and requires a new candidate.
- [ ] One durable, discoverable, correlated verdict is canonical. It contains the exact SHA, clean fingerprint, test generations, matrix status, residual gaps, and PASS/BLOCK. A Follow-up may link to it but never restate or supersede it.
- [ ] Trial the protocol on the next qualifying cross-cutting task and retrospect on whether it reduced stale reviews and late evidence discovery without slowing ordinary work.

## Interim retrospective evidence

- Mony: make the matrix risk-based and keep one canonical verdict; do not duplicate verdict content in Follow-ups.
- Dave: cover affected surfaces, dispositions, exact response compatibility, and an unchanged-path regression before QA.
- Kelly: include dependency boundaries and real-host evidence; process artifacts never replace crash, restart, privacy, or capacity proof.
- Mary: lock product meaning and pass rules before accepting green implementation evidence.

TASK-0140 remains open. This plan records collaboration improvements only and implies no TASK-0140 acceptance.

## Notes

An attempt to persist the interim synthesis through `leave_crew_post` returned `board-failed`. Do not claim the retrospective is on the Crew Board until a Member successfully persists it and returns the Post ID.

