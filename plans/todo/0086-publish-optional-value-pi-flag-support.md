---
id: TASK-0086
title: Publish optional-value Pi flag support
status: todo
depends_on: []
priority: high
tags: [pi-api, upstream, release, blocker]
---

# Publish optional-value Pi flag support

## Problem
The optional-value extension flag implementation exists locally but is not integrated or published upstream, so Bebop cannot consume it and the dependent picker work cannot start.

## Context
The implementation is committed locally as `c52fee539322490a676ea004694315adeee72d4b` and cherry-picks cleanly onto upstream HEAD `a79b373` in a throwaway clone. It has not been pushed, merged, or published.

## Acceptance criteria
- [ ] Obtain authorization to integrate the local commit upstream.
- [ ] Push or open the upstream integration path without rewriting unrelated work.
- [ ] Publish a Pi package version containing optional-value flags.
- [ ] Verify the published tarball contains the capability.

## Notes
No release or remote state may be changed without explicit authorization.

