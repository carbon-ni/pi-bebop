---
id: TASK-0036
title: Add member inbox enqueue operation and tool
status: done
depends_on: [TASK-0035]
priority: high
tags: [crew, inbox, application, tools, messaging]
---

# Add member inbox enqueue operation and tool

## Problem
Crew members need one explicit way to leave durable work for another configured member, with acknowledgement that means persisted rather than delivered or completed.

## Context

Expose one thin durable-message action over TASK-0035. Candidate tool name is `send_to_inbox`. It accepts same message/instructions as follow-up plus member target; it does not accept task, Git, workflow, priority, or completion fields.

After persistence, best-effort hint may ask online recipient to check trusted storage. Hint never contains authoritative item data and enqueue succeeds even if recipient offline.

## Acceptance criteria

- [ ] Joined member can enqueue ordinary structured message for configured offline/online peer by name or unique role.
- [ ] Unknown, ambiguous, self-target, unjoined, untrusted, invalid content/instructions, full inbox, and storage failures are distinct and tested.
- [ ] Tool derives crew origin, cannot choose storage path, and exposes no task/Git/workflow fields.
- [ ] Success returns stable item ID, target, and `persisted`; it does not claim delivery or response.
- [ ] Best-effort hint failure never rolls back persisted item.
- [ ] Tool/docs/UL distinguish inbox from follow-up and redirect.
- [ ] No endpoint liveness or recipient turn is required for successful enqueue.
- [ ] Application/tool tests and coverage/risk analysis pass.

## Out of scope

- Waiting for response, task tracking, permissions by role, listing/editing through enqueue tool, or Git integration.
