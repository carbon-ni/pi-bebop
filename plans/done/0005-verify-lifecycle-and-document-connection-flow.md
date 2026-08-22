---
id: TASK-0005
title: Verify lifecycle and document connection flow
status: doing
depends_on: [TASK-0003, TASK-0004]
priority: high
tags: [intray, lifecycle, docs, verification]
---

# Verify lifecycle and document connection flow

## Problem
Connection behavior must survive failures deterministically and be understandable to users and future agents.

## Context
Close implementation only after automated and real two-session behavior proves token-efficient pairing and deterministic cleanup.

## Acceptance criteria
- [x] Integration tests cover connect, peer send/reply, disconnect, stale peer, stop, and session shutdown across two runtimes.
- [x] `README.md`, relevant `AGENTS.md`, extension protocol docs, and intray skill describe connected-peer flow and direct `send_to_peer` usage.
- [x] `src/domain/reply-instruction.ts` remains unchanged; global `turn_end` correlation remains separate.
- [x] `npm test`, lint, typecheck, coverage, and `git diff --check` pass.
- [x] Manual two-session smoke test confirms no skill read, list tool, target argument, reverse metadata, or reciprocal wait.
- [x] Final report records changed files, verification, token-saving evidence, and remaining risks.

## Notes

