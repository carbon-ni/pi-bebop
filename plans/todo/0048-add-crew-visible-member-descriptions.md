---
id: TASK-0048
title: Add crew-visible member descriptions
status: todo
depends_on: []
priority: normal
tags: [crew, manifest, description, roster, context]
---

# Add crew-visible member descriptions

## Problem
Name and role are insufficient to distinguish members who share a role, while role instructions and Focus have different privacy/lifecycle semantics; crews need one small stable manifest-authored description that helps humans and agents choose the right member without becoming identity, permission, or current-work state.

## Context

Add optional inline `description` to each manifest member:

```json
{
  "name": "Bob",
  "role": "developer",
  "description": "Builds domain and application changes",
  "socket": "sockets/dev.sock"
}
```

Ubiquitous-language boundary:

- **Name:** exact configured individual identity.
- **Role:** broad responsibility and optional unique routing label.
- **Member Description:** stable manifest-authored, crew-visible specialty/responsibility summary.
- **Focus:** dynamic member-authored current activity (TASK-0046/0047; independent and currently held).
- **Role instructions:** behavioral/system guidance; not public profile.

Description helps a model choose exact name when several members share one role. It never becomes routing key, permission, origin field, or current-work signal.

## Implementation approach

1. Write failing manifest tests for optional field, strict validation, Unicode/byte bounds, and backwards compatibility.
2. Extend pure member schema/parser with named `MAX_MEMBER_DESCRIPTION_BYTES = 256` constraint.
3. Write failing membership-context and roster formatter tests before exposing description.
4. Include descriptions in joined member system context and `/crew members` output with deterministic manifest order.
5. Preserve concise presence activity, message origin, target resolution, and instructions behavior unchanged.
6. Document safe use and example crew; update ubiquitous language.

## Acceptance criteria

- [ ] Manifest accepts optional nonblank `description` string and preserves manifests with no description unchanged.
- [ ] Description is one trimmed line, valid Unicode, NUL-free, and at most 256 UTF-8 bytes under named constant; blank, padded, multiline, wrong-type, unknown-shape, and oversized values are rejected with member-specific actionable error.
- [ ] Description is inline only; no file/include, environment expansion, Markdown loading, or hot reload is introduced.
- [ ] Join/restore/rejoin snapshot description with manifest; active membership does not change until existing manifest reload lifecycle occurs.
- [ ] Membership system context lists manifest-order `name (role): description`; members without description remain concise and role instructions stay separate.
- [ ] `/crew members` shows optional description on same deterministic row while preserving exact `current|online|offline`, configured endpoint, manifest order, finite probes, and no-turn behavior.
- [ ] Presence roster/transitions remain concise and do not include descriptions.
- [ ] Message origin/payload, Inbox items, Crew Intake, Broadcast, and status responses do not gain description implicitly.
- [ ] Member targeting remains exact name or unique role; description is never searchable identity, authority, or uniqueness constraint.
- [ ] Description is documented crew-visible content and examples warn against secrets, credentials, customer data, or private prompt text.
- [ ] Multiple members may share role and description; exact name remains required when role ambiguous.
- [ ] Domain, context, roster, startup/restore, privacy, and regression tests pass, followed by coverage/risk analysis and final watcher gate.

## Out of scope

- Focus/current work, bios/avatars, permissions, automatic skill inference, description files, presence notification expansion, target ranking/routing, external profile API, or rich member directory UI.
