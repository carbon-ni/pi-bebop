---
id: TASK-0098
title: Split RPC handleCommand into per-command handlers
status: done
depends_on: []
priority: high
tags: []
---

# Split RPC handleCommand into per-command handlers

## Problem
pi/control-runtime.ts handleCommand is a 616-line dispatcher (cyclomatic 102, 18 command.type branches, depth 7). Every new RPC command edits the hottest file in the system and inline gates make cross-command regressions likely. Nothing about a new command should require touching unrelated branches.

## Context
From the 13-04-26 arch review (`.tmp/reports/13-04-26/codebase-map.md`, finding F1). `handleCommand` at `src/pi/control-runtime.ts#L237-L852`: 53 ifs, 9 catches, per-command membership/trust gates + payload validation + flow calls inline. Approach: command-handler registry `Map<RpcInboundCommand["type"], Handler>` under `src/pi/command-handlers/`, one module per command — mirrors existing `src/tools/` (one tool per module) and `src/cli/commands/` conventions. Incremental migration: extract one branch at a time behind the same `respond` closure; no behavior change per step. Start with the three longest branches (member_request, presence-*, subscribe).

## Acceptance criteria
- [ ] `handleCommand` reduced to dispatch + shared preconditions; cyclomatic complexity under 20.
- [ ] Each extracted command handler has a colocated test file covering happy + failure (gate rejections: not-joined / untrusted / invalid-payload).
- [ ] All `src/pi/*.integration.test.ts` stay green.
- [ ] Adding a new RPC command requires: one handler module + one registry line (verified by doing so or by inspection during review).

## Non-goals
- No protocol/wire changes.
- No changes to command semantics, gates, or response bytes.

## Notes
Full report: `.tmp/reports/13-04-26/codebase-map.md`. Consider having QA verify integration tests coverage before merge.
