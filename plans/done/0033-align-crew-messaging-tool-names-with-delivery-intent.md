---
id: TASK-0033
title: Align crew messaging tool names with delivery intent
status: done
depends_on: []
priority: high
tags: [crew, messaging, tools, ubiquitous-language]
---

# Align crew messaging tool names with delivery intent

## Problem
The public crew tools mix legacy session control with unclear urgency language: send_to_member remains registered after its planned removal, while send_immediate describes timing rather than its consequence of redirecting active work.

## Context

Keep `send_follow_up` as canonical normal delivery term: it accurately means “do not interrupt active work” and does not imply durable storage. Rename `send_immediate` to an intent name that makes active-work redirection explicit; current ubiquitous-language recommendation is `redirect_member`.

TASK-0031 intended to remove overloaded `send_to_member`, but production still registers it and extension-loading tests preserve it. Close that drift atomically instead of maintaining aliases. Durable inbox work is separate in TASK-0034 onward.

## Implementation approach

1. Write extension-loading and activation tests for final public tool set before changing registrations.
2. Keep `send_follow_up`; replace `send_immediate` with `redirect_member` across registration, labels, renderers, tests, docs, package artifacts, and agent guidance.
3. Remove legacy `send_to_member` registration and generic session-control surface from Bebop; retain direct `pi-bebop` CLI only where explicitly documented.
4. Update `UL.md` so follow-up, redirect, and inbox remain distinct concepts.
5. Do not retain deprecated aliases during active refactor.

## Acceptance criteria

- [ ] `send_follow_up` remains normal/default member messaging and never interrupts busy target.
- [ ] `redirect_member` is only public tool that can redirect active member work; description states consequence rather than transport mechanism.
- [ ] `send_immediate` and overloaded `send_to_member` are absent from production registration, tool snapshots, docs, and active guidance.
- [ ] Final tool parameters address configured member by name or unique role and do not expose transport mode selection.
- [ ] CLI direct-socket automation remains available without being presented as crew member tool.
- [ ] Tests cover registration, joined/unjoined activation, idle/busy dispositions, errors, and extension loading before production rename.
- [ ] `UL.md`, README, architecture, AGENTS guidance, source filenames, exports, labels, and package file list agree.
- [ ] Focused tests, coverage/risk analysis, and final watcher gate pass.

## Out of scope

- Durable inbox storage or delivery.
- Backward-compatible aliases.
- Generic session discovery/control tools.
