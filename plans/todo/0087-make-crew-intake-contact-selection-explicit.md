---
id: TASK-0087
title: Make Crew Intake contact selection explicit
status: todo
depends_on: []
priority: high
tags: [crew, intake, manifest, ux, tdd]
---

# Make Crew Intake contact selection explicit

## Problem
The manifest accepts intake.contact as a string but resolves it only as an exact member name. Because startup also selects members by role, a value such as po looks valid and produces a misleading role-join failure even when po is a configured role.

## Context

Crew member names are unique: `parseCrewManifest` rejects `duplicate-member-name`.
Roles are intentionally not unique because several members may share one responsibility.
Crew Intake therefore needs an exact member name, while `--crew-role` may select a unique role.

Use an explicit selector instead of overloading one string:

```json
"intake": { "contact": { "role": "po" } }
```

An exact identity remains available as `{ "name": "Mary" }`. Role selection is valid only when exactly one configured member has that role.

## Plan

1. Add failing manifest and Intake tests for `{ "name": "Mary" }`, unique `{ "role": "po" }`, ambiguous roles, unknown names/roles, both selector fields, and empty selectors.
2. Replace string `intake.contact` with a strict selector containing exactly one of `name` or `role`; do not keep implicit string fallback.
3. Resolve the selector during manifest validation to one canonical member so downstream Intake, membership context, CLI acknowledgement, and inbox routing do not repeat selection logic.
4. Return deterministic ambiguity errors listing matching member names in manifest order.
5. Update Crew Init, project manifest, examples, architecture/workflow docs, and startup diagnostics to use and explain explicit selectors.
6. Verify parser, startup-role happy/unhappy paths, generated manifest, membership context, and CLI Intake integration.

## Acceptance criteria

- [ ] `{ "role": "po" }` resolves Mary when Mary is the only member with role `po`.
- [ ] `{ "name": "Mary" }` resolves Mary by unique member name regardless of her role.
- [ ] A repeated role fails validation and lists matching member names deterministically; it never picks by order or presence.
- [ ] Unknown names and roles report which selector failed.
- [ ] String contact, empty selector, unknown fields, and selectors containing both `name` and `role` fail strict validation.
- [ ] Downstream Intake behavior consumes one canonical resolved contact without fallback selection.
- [ ] Generated and repository manifests use explicit selectors; documentation distinguishes unique names from repeatable roles.

## Notes

This intentionally changes the manifest contract. If manifest version represents schema compatibility, increment it and migrate all owned examples atomically rather than preserving the deprecated string path.

