---
id: TASK-0088
title: Make user-facing errors actionable
status: todo
depends_on: []
priority: high
tags: [errors, ux, cli, tools, configuration, tdd]
---

# Make user-facing errors actionable

## Problem
User-facing failures often state only a technical symptom. Users need every pi-bebop-owned error to explain what failed, where the problem is, and what they can do next.

## Context

The Intake failure is one example:

```text
Crew startup role join failed: intake contact is not a configured member: product
```

It says why validation stopped, but not that the source is Crew configuration, where that configuration lives, which field is invalid, or how to correct it.

Apply one error contract to pi-bebop-owned user-facing surfaces: startup, CLI commands, Pi commands, registered tools, Crew membership, Intake, Inbox, configuration, and filesystem operations.

An actionable error answers, when the information is known:

1. **What failed?** Name the user operation, not only an internal component.
2. **Where?** Name relevant command, safe path, field, member, or input.
3. **Why?** State rejected condition and value without exposing secrets.
4. **What next?** Give one or more concrete corrective actions.

## Plan

1. Inventory pi-bebop-owned messages that reach users and group them by error code or failure type.
2. Define one reusable presentation contract while keeping domain errors structured and independent of UI wording.
3. Add failing tests for representative errors from each user-facing surface.
4. Rewrite vague messages with concise context and corrective action.
5. Verify text, TOON, and JSON surfaces preserve stable machine-readable codes and details.
6. Document the error contract for future commands and tools.

## Acceptance criteria

- [ ] Every pi-bebop-owned error exposed to a user identifies the failed operation and explains the failure in user-facing domain language.
- [ ] Every error identifies where to fix the problem when location is known: command or flag, safe path, configuration field, member, or supplied input.
- [ ] Every recoverable error gives at least one concrete next action; an unrecoverable or unknown failure says what evidence to collect instead of inventing a fix.
- [ ] Errors with constrained valid inputs list deterministic valid choices when the list is bounded and safe.
- [ ] Text remains concise; structured CLI/tool output retains stable error code plus actionable message and relevant safe details.
- [ ] Errors never expose credentials, message reply routes, unsafe absolute paths, stack traces, or internal implementation names by default.
- [ ] Tests cover representative startup, CLI, Pi command, tool, configuration, membership, filesystem, and transport failures.
- [ ] Existing success output, failure exit status, and domain semantics remain unchanged unless separately specified.

## Non-goals

- Rewriting errors owned entirely by Pi, Node.js, the operating system, or external dependencies when pi-bebop has no meaningful context.
- Guessing a corrective action when cause is unknown.
- Silently correcting invalid input or configuration.
- Combining unrelated failure causes into one generic message.

## Notes

TASK-0087 is the first concrete example and should conform to this contract without waiting for a full repository-wide migration.

