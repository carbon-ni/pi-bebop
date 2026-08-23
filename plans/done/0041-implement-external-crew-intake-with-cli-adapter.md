---
id: TASK-0041
title: Implement external crew intake with CLI adapter
status: done
depends_on: [TASK-0038, TASK-0040]
priority: high
tags: [crew, external, cli, inbox, security]
---

# Implement external crew intake with CLI adapter

## Problem
External actors need a minimal one-way surface that persists a message for the configured crew contact while offline, without joining the crew, broadcasting, claiming authentication, or introducing a routing/workflow engine.

## Context

Implement Crew Intake as application operation independent from concrete ingress. Add CLI as first adapter by extending existing `pi-bebop send` with mutually exclusive explicit crew target, reusing Inbox storage and TASK-0040 contact resolution:

```bash
pi-bebop send --crew .pi/bebop/crew.json \
  --message "Please evaluate this product request" \
  --from "jira-automation"
```

`--socket` remains direct live endpoint delivery. `--crew` means durable one-way intake through configured contact and returns persisted acknowledgement. CLI does not join crew or acquire member origin. Application operation must be reusable by future local adapters without importing CLI types.

## Acceptance criteria

- [ ] One application operation owns external intake validation, contact resolution, payload attribution, Inbox enqueue, and persisted acknowledgement.
- [ ] Application operation depends on abstractions and contains no CLI/Pi/TUI types.
- [ ] `pi-bebop send` is first thin adapter and accepts exactly one of `--socket` or `--crew <manifest>` with self-correcting usage errors.
- [ ] `--crew` requires explicit manifest path in exact supported layout, resolves configured contact, and uses shared durable Inbox operation.
- [ ] CLI documents explicit path as caller consent; it enforces layout/filesystem safety but never reports project as Pi-trusted.
- [ ] Success output includes item ID, contact name/role, and `persisted`; it never says delivered, completed, assigned, or answered.
- [ ] Contact may be offline; no endpoint probe or running Pi session is required.
- [ ] Optional `--from` is stored as explicit external/unverified origin; no crew origin can be claimed through CLI.
- [ ] Missing/invalid manifest, disabled/missing contact, unsafe layout, full inbox, malformed message/instructions, and persistence failure have distinct stable errors and nonzero exit codes.
- [ ] Existing direct `--socket` behavior and JSON/TOON/text formats remain backward compatible.
- [ ] Concurrent external sends preserve TASK-0035 FIFO/durability contract.
- [ ] End-to-end test persists external message while contact offline, then contact joins and receives it through TASK-0037 follow-up handoff.
- [ ] README and role examples show external actor → configured product contact → triage → optional internal forwarding, with explicit one-way limitation and non-goals.
- [ ] Package smoke, CLI tests, integration tests, coverage/risk analysis, and final watcher gate pass.

## Out of scope

- Additional ingress adapters, HTTP server, remote exposure, authentication, callbacks, waiting for response, broadcasts, routing rules, or task/Git integration.

