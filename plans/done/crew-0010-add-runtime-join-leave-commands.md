---
id: TASK-0010
title: Add runtime crew join and leave commands
status: done
depends_on: [TASK-0009]
priority: high
tags: [intray, crew, command]
---

# Add runtime crew join and leave commands

## Problem
A running Pi instance cannot currently incorporate or release a crew role without restart.

## Context
Extend consolidated `/intray` command with explicit identity operations. `join` changes current intray identity; existing `connect` continues to target another instance.

## Acceptance criteria
- [x] Tests first cover `/intray join <socket>`, `/intray leave`, missing paths, relative paths from `ctx.cwd`, extra arguments, paths containing spaces, and runtime failures.
- [x] `/intray join <socket>` starts/ensures base server without enabling legacy peer listening and delegates to membership runtime once.
- [x] Successful join reports crew, member, and endpoint without mutating Pi `/name`.
- [x] `/intray leave` releases membership while base intray remains online.
- [x] `/intray status` displays current crew/member/endpoint when joined.
- [x] Command completion and usage text include join and leave.
- [x] Headless modes return clear errors without attempting interactive selection.
