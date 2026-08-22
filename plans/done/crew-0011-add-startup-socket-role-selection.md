---
id: TASK-0011
title: Add startup socket role selection
status: done
depends_on: [TASK-0009]
priority: normal
tags: [intray, crew, cli]
---

# Add startup socket role selection

## Problem
Starting directly as a crew member currently requires repeating crew and role information instead of selecting one endpoint path.

## Context
Add one primary string flag: `--intray-socket <path>`. Crew and member are reverse-resolved from that path; separate crew/member flags are not required for normal flow.

## Acceptance criteria
- [x] Tests first cover valid startup join, missing manifest, unknown member socket, occupied endpoint, relative path, and disabled/headless startup.
- [x] `--intray-socket <path>` implies intray server startup and delegates once on every `session_start` to the same membership runtime as `/intray join`.
- [x] Relative paths resolve against startup `ctx.cwd`; leading `@` path notation is normalized.
- [x] Startup failure is explicit and leaves no local endpoint or partial membership state.
- [x] Existing `--intray` and `--in` behavior remains unchanged when socket flag is absent.
- [x] Flag description communicates that selected endpoint becomes current intray identity.
