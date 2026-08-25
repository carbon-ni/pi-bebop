---
id: TASK-0087
title: Make Crew Intake contact errors actionable
status: todo
depends_on: []
priority: high
tags: [crew, intake, manifest, errors, ux, tdd]
---

# Make Crew Intake contact errors actionable

## Problem

When `intake.contact` does not match a configured member name, startup reports only a technical symptom:

```text
Crew startup role join failed: intake contact is not a configured member: product
```

The failure does not identify Crew configuration, its manifest path or field, so users cannot tell where or how to fix it.

## Context

`intake.contact` remains an exact configured `members[].name`. Roles are intentionally not unique and must not be inferred. This task improves diagnostics only; it does not change the manifest schema or selection semantics.

The diagnostic is the first concrete slice of the product-wide actionable error contract in TASK-0088.

## Plan

1. Add failing tests for unknown Intake contacts through manifest loading and startup role join.
2. Preserve structured domain error identity while adding safe presentation context at the boundary.
3. Identify Crew configuration, actual safe manifest path, field `intake.contact`, rejected value, and valid exact member names in deterministic manifest order.
4. Tell the user to change `intake.contact` to an existing member name or add a matching member.
5. Verify canonical and compatibility manifest layouts without changing startup success behavior.

## Acceptance criteria

- [ ] Unknown `intake.contact` identifies the failed Crew startup operation and says Crew configuration is invalid.
- [ ] The error identifies the actual safe manifest path and field `intake.contact`.
- [ ] The error shows the rejected value and available exact member names in deterministic manifest order.
- [ ] The error tells the user to select an existing member name or add a member with the requested name.
- [ ] Exact-name contact semantics remain unchanged; role inference and silent correction are absent.
- [ ] Canonical and compatibility manifest paths are covered by deterministic tests.
- [ ] Existing success output and failure status remain unchanged.

## Non-goals

- Changing `intake.contact` from its string member-name schema.
- Adding name/role selector objects or inferring contacts from roles.
- Migrating configuration or silently rewriting invalid values.
- Completing the repository-wide error migration tracked by TASK-0088.
