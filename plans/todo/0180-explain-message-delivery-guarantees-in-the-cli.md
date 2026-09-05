---
id: TASK-0180
title: Explain message delivery guarantees in the CLI
status: todo
depends_on: [TASK-0170, TASK-0174]
priority: high
tags: [cli, help, messaging, guarantees, onboarding, ubiquitous-language]
---

# Explain message delivery guarantees in the CLI

## Problem

Overlapping communication commands use precise but unfamiliar states, and command help sometimes points to agent tool names instead of runnable CLI commands. Users need one decision guide that compares correlation, durability, ordering, interruption, offline behavior, and terminal guarantees.

## User story

As a Crew coordinator, I want `pi-bebop help delivery` to tell me which command fits my intent so that I do not mistake accepted delivery for a Response or choose an unsafe transport.

## Acceptance criteria

- [ ] `pi-bebop help delivery` compares `ask`, Follow-up, Redirect, Inbox, Broadcast, Crew Intake, Interrupt, and low-level Member Request using canonical product terms.
- [ ] Each row states recipient scope, Response correlation, durability, offline behavior, ordering, interruption/abort behavior, waiting, and the strongest provable success state.
- [ ] Accepted, Persisted, Handoff, Direct, Queued, Redirected, Completed, Response, timeout, and Request outcome are defined at point of use with explicit “does not mean” boundaries.
- [ ] The guide recommends one runnable CLI command for each common intent and never points CLI users to an agent tool name.
- [ ] `member status --help` and other command-local help link to the actual CLI equivalent, such as `pi-bebop ask` or `member request send`, rather than `send_member_request`.
- [ ] Timeout defaults/limits and compatibility requirements are visible where waiting is offered.
- [ ] Command hierarchy and aliases are generated or checked against the Commander registry so the guide cannot advertise missing commands.
- [ ] Help is deterministic concise text, performs no Crew/session/filesystem IO, and exits 0 with clean stderr.
- [ ] README uses the same guarantee matrix source or has a stale-content gate.
- [ ] Tests fail when a communication command, state, default, or guarantee changes without updating the guide.

## Non-goals

Changing delivery behavior, adding prompts, embedding full manuals in every command, or claiming recipient comprehension/completion.
