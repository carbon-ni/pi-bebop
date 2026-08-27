---
id: TASK-0113
title: Collect repository evidence for retrospectives
status: todo
depends_on: [TASK-0111]
priority: high
tags: [crew-agreements, retrospective, evidence, git, plans, verification, tdd]
---

# Collect repository evidence for retrospectives

## Problem
Commits, plan transitions, reports, and verification outcomes contain much of the Crew's shared work history, but they are not assembled into one interval-bounded evidence source for retrospectives.

## Context
Repository evidence is shared Crew work, but availability differs by project; absence must remain visible rather than being interpreted as no work.

## Acceptance criteria
- [ ] Injected adapters collect a documented v1 source set within the interval: reachable Git commits, `plans/` lifecycle changes, retained reports, and retained watcher/verification evidence.
- [ ] Every item preserves exact repository-relative path, commit/task/generation identifier when available, and source snapshot/provenance; no network fetch occurs.
- [ ] Diff/report content is bounded with deterministic ordering/truncation and stable references for drill-down; credentials/secrets and unsafe absolute paths are redacted.
- [ ] Shared facts such as one task referenced by commit, plan, and report deduplicate or cross-link without erasing distinct provenance.
- [ ] Dirty worktree, missing plans/reports/watcher retention, detached HEAD, rewritten history, command failure, and unsupported repository remain explicit states—not regressions or absence of work.
- [ ] Collector is read-only and mockable; same repository snapshot and interval yield the same evidence bytes.
- [ ] Tests cover each source, mixed/missing sources, interval boundaries, history changes, dirty tree, redaction, truncation, command timeout, and deterministic rerun.

## Non-goals
Network issue trackers, arbitrary plugin ecosystems, evaluating code quality, assigning work, or interpreting test failure causes.
