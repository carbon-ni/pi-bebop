---
id: TASK-0156
title: Replace protocol command mapping if-chains with a command registry
status: todo
depends_on: []
priority: normal
tags: [refactor, protocol, dispatch]
---

# Replace protocol command mapping if-chains with a command registry

## Problem

requestToCommand (CC 52) and commandToRequest (CC 25) in src/domain/protocol.ts
map between RPC commands and domain requests through long if-chains keyed on
command name. Adding a command requires editing two mirrored chains, and the
mapping is invisible at the type level.

## Desired outcome

A single command registry: one entry per command declaring its request schema,
response shape, and both directions of mapping. `requestToCommand` and
`commandToRequest` become table lookups plus shared encode/decode logic.
Adding a command means adding one registry entry (plus its tests), not editing
two chains.

## Approach

1. Characterization first: protocol tests already pin encode/decode behavior
   for every command; extend where a branch is untested.
2. Define `CommandDefinition` (TypeBox schema, request mapper, command mapper)
   and a `Record<CommandName, CommandDefinition>` registry.
3. Rewrite both mappers as registry-driven loops; error messages for unknown
   or invalid payloads stay byte-identical where tests assert them.
4. Target: each mapper CC < 15; registry entries are plain data (testable
   without mocks).

## Acceptance criteria

- [ ] `requestToCommand` and `commandToRequest` CC < 15 each.
- [ ] One registry entry per command; no command name string duplicated
      across two chains.
- [ ] Wire format unchanged: existing protocol tests pass unmodified except
      where they only asserted internal call shapes.
- [ ] Domain stays pure (typebox only, no IO).

## Non-goals

No file split (TASK-0157), no new commands, no wire/protocol changes.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

