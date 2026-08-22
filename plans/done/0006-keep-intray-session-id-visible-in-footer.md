---
id: TASK-0006
title: Keep intray session id visible in footer
status: done
depends_on: []
priority: high
tags: [intray, ui, regression]
---

# Keep intray session id visible in footer

## Problem
The footer prefixes connection state before the session id, so Pi truncation hides the end of the id and prevents users from copying the connection target.

## Context
Pi truncates long footer status values from the end. Current text places `intray listening (` before the UUID, so the UUID is the part lost.

## Acceptance criteria
- [x] A failing test captures footer formatting before implementation.
- [x] Full local session id appears first in enabled intray footer status.
- [x] Listening/online/connected state remains readable after the id.
- [x] Connected peer remains visible when width allows, without sacrificing local id priority.
- [x] Tests, typecheck, lint, watcher gate, and diff-check pass.

## Notes

Red: localized footer regression test failed against `intray listening (<id>)` ordering. Green: localized 4/4 tests and watcher generation 8 pass.
