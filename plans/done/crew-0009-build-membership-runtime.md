---
id: TASK-0009
title: Build crew membership runtime
status: done
depends_on: [TASK-0007, TASK-0008]
priority: high
tags: [intray, crew, runtime]
---

# Build crew membership runtime

## Problem
Startup and running-session role adoption need one reusable operation so membership state and endpoint ownership cannot drift between entry points.

## Context
Create a focused membership runtime that composes manifest lookup and endpoint ownership. Pi extension wiring stays in composition layer.

## Acceptance criteria
- [x] Tests first cover join, same-member retry, leave, role switch, busy target, malformed crew, and claim/release failures.
- [x] Join derives crew and member only from selected socket path and stores normalized membership state.
- [x] Joining same endpoint is idempotent while revalidating physical endpoint ownership.
- [x] Role switch claims new endpoint before releasing old endpoint.
- [x] Failed switch preserves previous membership and endpoint.
- [x] Leave is idempotent and does not stop base intray server.
- [x] Membership runtime uses injected manifest and endpoint dependencies and contains no direct Pi API calls.
