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

Keep this deterministic identity rule. Fix the affordance and diagnostics rather than silently changing Intake to role routing.

## Plan

1. Add manifest parser tests first for a contact value that matches a unique role, an ambiguous role, and no configured identity.
2. When a value matches a role, return an actionable error saying `intake.contact` expects an exact member name. For a unique role, suggest its member name; for an ambiguous role, list the matching names in manifest order.
3. Distinguish invalid-manifest startup failures from unknown `--crew-role` failures so role join does not imply the requested startup role is invalid.
4. Update Crew Init and workflow documentation to show `intake.contact` beside the selected member name and state that roles may repeat.
5. Verify parser, startup-role happy/unhappy paths, generated manifest, and CLI Intake integration.

## Acceptance criteria

- [ ] `intake.contact: "po"` with member `Mary` in role `po` reports that contact expects member name and suggests `Mary`.
- [ ] A repeated role never selects an Intake contact implicitly and reports all matching member names deterministically.
- [ ] An unknown contact reports that no configured member has that exact name.
- [ ] Startup labels malformed manifest errors separately from unknown or ambiguous startup role selection.
- [ ] Exact-name contact and unique startup-role selection continue to resolve the same member.
- [ ] Documentation explicitly distinguishes unique member names from repeatable roles.

## Notes

A future schema could support explicit selectors such as `{ "name": "Mary" }` and `{ "role": "po" }`, but that is a product/schema change. Do not overload the current string implicitly as both.

