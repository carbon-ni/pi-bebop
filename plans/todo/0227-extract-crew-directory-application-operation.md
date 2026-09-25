---
id: TASK-0227
title: Extract Crew directory application operation
status: todo
depends_on: [TASK-0223]
priority: high
tags: [refactor, cli, application, discovery, aesthetics, tdd]
---

# Extract Crew directory application operation

## Problem

`src/cli/commands/crew-list.ts:executeCrewListCommand` performs trusted discovery, manifest reads, availability probes, live/observed record merging, partial-failure handling, ordering, and CLI presentation. Other surfaces cannot reuse listing without depending on CLI code. A one-call wrapper does not reduce this reader burden.

## Deliverable

A typed, injected application operation for Crew directory discovery, consumed by a thin CLI adapter.

## Scope and approach

- Characterize current command behavior before extraction.
- Give the workflow meaningful stages: discover, inspect, merge, return evidence.
- Keep Commander options and CLI outcomes at the edge; application results describe directory entries and partial-discovery evidence.
- Preserve listing policy separately from target routing; do not unify with `crew-target-resolution.ts` solely because both discover crews.

## Acceptance criteria

- [ ] Application operation has no dependency on CLI context, Commander, output format, or concrete default IO.
- [ ] CLI remains responsible for options and presentation, with unchanged text/JSON/TOON output and full/truncated behavior.
- [ ] Tests preserve trusted paths, bounded discovery, concurrent probing, observed/live merging, deterministic ordering, duplicate-selector recovery, malformed candidates, and offline availability.
- [ ] Cancellation and timeout still return honest partial results and release discovery resources; no locator leakage is introduced.
- [ ] Operation is testable directly with fake dependencies. Existing CLI tests plus focused coverage and fresh watcher final gate pass.

## Non-goals

Changing public discovery semantics, expanding search scope, merging routing/listing policy, or hiding complexity in an unstructured helper.
