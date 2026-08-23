---
id: TASK-0052
title: Expose Crew contact in joined membership context
status: doing
depends_on: [TASK-0040,TASK-0049]
priority: normal
tags: [crew, context, intake, contact, communication, tokens]
---

# Expose Crew contact in joined membership context

## Problem
Joined members already receive current identity and roster, but cannot see which exact configured member owns external Crew Intake triage. Add one explicit manifest-derived Crew contact line so agents understand the communication entry point without inferring product, lead, first, or online member.

## Context

Current joined system block already includes current identity, manifest path, manifest-order member names/roles/descriptions, and current member Role instructions. Extend it with exactly one communication-entry line:

Configured Intake:

```text
Crew contact: Mary (product) — external Intake triage
```

No configured Intake:

```text
Crew contact: none (Crew Intake disabled)
```

**Crew contact** keeps its existing ubiquitous-language meaning: exact manifest member selected by `intake.contact` to triage unverified external Crew Intake. It is not lead, manager, authority, default internal recipient, or permission. Internal member communication still targets an exact member name or unique role through existing tools.

This line is system-prompt context only while joined. It is derived from already trusted/snapshotted manifest and does not create custom chat history. Tool schemas remain generic and do not auto-route through contact.

## Implementation approach

1. Write failing `membership-context` tests for configured contact, absent contact, self-as-contact, and unjoined prompt.
2. Derive contact name and role from parsed manifest; never trust a duplicated role/name field or infer fallback.
3. Add one deterministic line to `formatMembershipContext` without changing roster, descriptions, Role instructions, or marker idempotence.
4. Document that contact is external Intake triage only and measure joined prompt delta.

## Acceptance criteria

- [x] Joined context with `intake.contact` includes exactly `Crew contact: <name> (<role>) — external Intake triage` using matching configured member.
- [x] Joined context without `intake` includes exactly `Crew contact: none (Crew Intake disabled)`; no lead/product/first/online fallback is inferred.
- [x] Same line is shown whether current member is contact or another member; it grants no extra tool or visibility permission.
- [x] Unjoined `before_agent_start` remains byte-identical and membership tools remain inactive under TASK-0049 lifecycle.
- [x] Contact line appears once per built system prompt and existing context marker still prevents duplicate append.
- [x] Existing member roster keeps manifest order, names, roles, and optional descriptions; only current member Role instructions are injected.
- [x] Contact comes from trusted manifest snapshot loaded at join/restore/rejoin; active file edits do not hot-reload context.
- [x] No socket path, session id, alias, Intake message content, external label, prompt, tool result, or instructions from another member are added.
- [x] No agent tool automatically routes through contact; `member` parameters continue resolving exact name or unique role.
- [x] Documentation distinguishes Crew contact (external Intake triage) from lead coordination and ordinary member-to-member communication.
- [x] Token report records exact configured/disabled line cost and confirms no duplicated workflow ladder/tool guidance is injected.
- [x] Focused context/lifecycle tests plus fresh final watcher gate pass.

## Out of scope

- Changing manifest schema, contact selection, Crew Intake persistence/CLI, automatic routing, fallback, role permissions/hierarchy, contact status/Focus, multiple contacts, external authentication, tool-schema changes, or injecting full communication workflow into every prompt.

