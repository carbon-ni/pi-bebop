---
id: TASK-0043
title: Implement durable broadcast-to-crew tool
status: done
depends_on: [TASK-0038, TASK-0042]
priority: high
tags: [crew, broadcast, tools, application, inbox]
---

# Implement durable broadcast-to-crew tool

## Problem
Crew members need one compact agent-facing action that durably fans one non-interrupting message out to every other configured member with deterministic partial-failure and retry behavior.

## Context

Add one thin joined-member tool over shared Inbox repository/application seam:

```text
broadcast_to_crew({
  message: "API contract changed; pull latest plan before continuing",
  instructions: ["Acknowledge constraint in your next normal report"]
})
```

No member parameter: target is exactly every other configured member. No urgency/mode/wait parameter: broadcast is durable and non-interrupting. Tool returns compact summary plus typed per-recipient details.

## Acceptance criteria

- [ ] `broadcast_to_crew` is registered only while joined and accepts message plus ordered instructions only.
- [ ] Tool derives current crew origin and manifest snapshot at execute time; caller cannot select/exclude recipients or override origin.
- [ ] One application operation fans out through Inbox abstraction and contains no Pi/TUI types.
- [ ] Stable broadcast ID is generated once per invocation and supports explicit idempotent retry path defined by TASK-0042.
- [ ] Success text says persisted for N recipients; details list manifest-order member, item ID, and disposition.
- [ ] Partial result is an error/partial outcome with successful and failed recipients clearly preserved; retry does not duplicate success.
- [ ] Offline recipients work identically to online recipients and no endpoint probes occur.
- [ ] Recipient Inbox handoff remains normal follow-up and never redirects active turns.
- [ ] Unjoined, single-member crew, full inbox, invalid payload, storage error, abort, concurrent broadcast, and partial crash are tested.
- [ ] Tool description teaches broadcast for shared information, not assignment that should have one owner.
- [ ] README/UL/role examples explain internal-only scope and recommend direct follow-up/inbox for targeted work.
- [ ] Package smoke, integration tests, coverage/risk analysis, and final watcher gate pass.

## Out of scope

- External callers, live-only broadcast, redirects, response waiting/aggregation, recipient filters, group chat, or task/Git integration.

