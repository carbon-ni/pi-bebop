---
id: TASK-0085
title: Remove self-reported member Focus
status: done
depends_on: []
priority: high
tags: [crew, status, focus, removal, determinism, tdd]
---

# Remove self-reported member Focus

## Problem
Focus is manually reported, can become stale, and may be mistaken for progress or availability; leads can obtain current intent or progress explicitly by requesting a response from the member.

## Context

Member Status should contain only mechanically observed runtime facts. Remove the
entire self-reported Focus vertical slice rather than rename or deprecate it.
When a lead needs intent, progress, a report, or a verdict, the lead asks the
member explicitly with `send_member_request`; ordinary context can use
`send_follow_up`. A correlated Response is fresher and makes epistemic status
clear instead of relying on persistent advisory text.

This is an intentional contract removal across domain, application, protocol,
Pi extension, agent tools, standalone CLI, tests, and documentation. Do not keep
hidden compatibility commands or fields. Historical `bebop-member-focus`
session entries remain inert unknown custom entries and must not affect status.

## Acceptance criteria

- [ ] Tests are changed first to define mechanical-only Member Status and prove removed surfaces are absent.
- [ ] `get_member_status` returns only member identity, presence, activity, pending-message state, and observation time; online/offline schemas contain no Focus state or text.
- [ ] Remove the `update_member_focus` agent tool from registration, active membership tools, exports, descriptions, tests, and generated/tool contract expectations.
- [ ] Remove `pi-bebop member focus set|clear` from command registry, parsing, handlers, help, valid-command hints, package tests, and CLI parity contracts.
- [ ] Remove the `member.focus` RPC method, params/results, routing, protocol schemas, application operations, and infra method mapping; a new request using that removed method follows the standard unknown-method response.
- [ ] Remove Focus validation, entry creation/restoration, timestamps, member-status formatting, and related domain/application exports.
- [ ] Existing historical `bebop-member-focus` custom session entries are ignored without error and never appear in status; no migration or cleanup IO is introduced.
- [ ] Presence, idle/busy/compacting, pending-message, idle-wait, membership restore, and status query behavior remain unchanged apart from removed Focus fields.
- [ ] Lead workflow documentation directs intent/progress/report questions to `send_member_request` and treats correlated Response—not status—as the evidence boundary.
- [ ] README, architecture, Member Status, software crew workflow, CLI parity Markdown/JSON, tool affordances, and examples contain no active Focus feature references.
- [ ] Package/public API verification proves Focus commands, tool, schemas, and help are absent rather than deprecated.

## Out of scope

- Inferring work from conversation, tools, Git, plans, or runtime activity;
  replacing Focus with another persistent advisory field; changing mechanical
  activity semantics; or automatically polling members for progress.

## Verification

- Run focused domain, application, RPC, Pi integration, tool registry, CLI
  registry/help/parity, package, and documentation checks.
- Measure touched-code coverage and inspect change impact around Member Status and
  protocol public APIs.
- Run fresh final watcher gate with unchanged worktree fingerprint.

## Notes

Product rule: mechanical status answers whether a runtime is reachable and what
Pi is doing. Member communication answers what work means and whether it is done.

