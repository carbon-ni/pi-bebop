---
id: TASK-0172
title: List locally known Crews by public identity
status: todo
depends_on: [TASK-0171, TASK-0170]
priority: high
tags: [cli, crew, discovery, identity, privacy, toon, text, tdd]
---

# List locally known Crews by public identity

## Problem

Users cannot discover Crews and Members in product language because session discovery exposes runtime identities without Crew context. They need a concise Crew directory that never requires or reveals transport details by default.

## User story

As a Crew coordinator, I want `pi-bebop crew list` to show the Crews I can address so that I can use stable public names instead of inspecting Pi sessions.

## Acceptance criteria

- [ ] `pi-bebop crew list` emits one row per Crew in deterministic selector order, deduplicating multiple live Member sessions for the same Crew.
- [ ] Trust is checked before any manifest IO. Discovery reads only the canonical `.pi/bebop/crew.json` or explicit `.pi/crew/crew.json` compatibility layout reached through an already-authorized membership; it never scans arbitrary manifests or creates transport authority from file presence.
- [ ] Each row exposes only contract-approved product fields such as Crew selector, display name, configured Member count, and bounded mechanical reachability summary.
- [ ] Duplicate display names remain separate and visibly require their stable Crew selectors; the CLI never guesses.
- [ ] No default output contains session IDs, aliases, runtime sockets, Member endpoint paths, capability values, manifest paths, or Request IDs.
- [ ] Empty discovery is successful and explains how a Crew becomes locally addressable without exposing transport setup.
- [ ] Stale/unreachable/malformed candidates do not corrupt valid Crew rows; partial discovery is explicit and deterministically ordered.
- [ ] TOON default, explicit text/JSON, empty/error, truncation, and semantic TOON round-trip follow TASK-0165/TASK-0170 contracts.
- [ ] Discovery is bounded, concurrent where safe, cancellable, and performs no mutation or model turn.
- [ ] Root/leaf help contains runnable examples and explains Crew selector versus display name.
- [ ] Existing `session list` remains an explicit diagnostic/compatibility command until its separate deprecation is approved; `crew list` is the product route.

## Non-goals

Starting or joining Crews, choosing a Member for a question, reporting work progress, or exposing transport topology.
