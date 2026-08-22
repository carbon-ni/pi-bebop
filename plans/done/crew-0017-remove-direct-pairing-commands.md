---
id: TASK-0017
title: Remove direct pairing commands
status: done
depends_on: [TASK-0012, TASK-0016]
priority: high
tags: [intray, crew, cleanup, command]
---

# Remove direct pairing commands

## Problem
After socket-path targeting is available, `/intray listen`, `/intray connect`, and `/intray disconnect` retain obsolete one-peer workflow and ambiguous meaning beside crew `join`/`leave`.

## Context
Remove human-facing pairing entry points while preserving base server lifecycle and observation commands. Do not add deprecation aliases during active refactor.

## Acceptance criteria
- [x] Replacement tests prove `/intray join`, `/intray leave`, and socket-path targeting before command removal.
- [x] `listen`, `connect`, and `disconnect` are removed from command parser types, completions, usage, handlers, and tests.
- [x] Pairing-only `connection-runtime.ts` and its tests are removed.
- [x] `/intray` supports `join`, `leave`, `list`, `status`, and `stop` with deterministic arity errors.
- [x] `/intray list` remains observation-only and does not create connection state.
- [x] `stop` releases crew membership and base server resources without a peer-disconnect attempt.
- [x] CLI and README examples contain no active pairing commands.
