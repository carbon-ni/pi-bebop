---
id: TASK-0045
title: Implement interrupt-member recovery flow
status: todo
depends_on: [TASK-0044]
priority: high
tags: [crew, interrupt, tools, protocol, recovery]
---

# Implement interrupt-member recovery flow

## Problem
Crew needs a live-only emergency tool that durably records recovery guidance, aborts target active operation, and hands recovery message to Pi ahead of queued follow-ups without pretending to roll back completed side effects.

## Context

Implement only after TASK-0044 proves lifecycle sequence. Prefer one target-owned `message.interrupt` JSON-RPC operation so validation, pending-evidence persistence, abort, and recovery scheduling form one server-side state machine rather than client-side `abort` + `send` race.

Proposed recovery evidence uses stable session custom entries:

```text
interrupt.pending -> abort requested -> recovery custom message handed to Pi -> interrupt.handed-off
```

On reload, pending without handed-off evidence retries recovery before normal continuation under proven TASK-0044 contract. Target is live-only at request time; durable Inbox is not fallback because it cannot break active flow.

## Acceptance criteria

- [ ] Strict schema-validated `message.interrupt` request/result carries stable interrupt ID and structured MessagePayload.
- [ ] Target handler validates joined membership, caller-derived crew origin, configured non-self target, and one-pending constraint before side effects.
- [ ] Pending recovery evidence is persisted before abort request; message content never appears in logs/errors.
- [ ] Busy flow requests `ctx.abort()` and delivers exactly one recovery custom message before older queued follow-ups according to characterized sequence.
- [ ] Idle flow starts recovery directly and returns `direct`; busy flow returns `interrupt-requested` only after pending evidence and abort request succeed.
- [ ] `interrupt_member` has only member, message, and ordered instructions; no mode, wait, reply, broadcast, or external-origin parameters.
- [ ] Tool description says use only to stop/recover active work that is stuck, harmful, or based on invalid assumptions; normal urgency uses Redirect.
- [ ] Concurrent interrupts, abort failure, target shutdown, malformed response, timeout, reload, duplicate RPC, and sender cancellation preserve deterministic recovery state.
- [ ] Recipient UI clearly shows interruption origin/recovery guidance and warns that prior side effects were not rolled back.
- [ ] Existing session.abort remains generic protocol operation but no client composes it with message.send to approximate interrupt.
- [ ] Unit, protocol, real-host lifecycle, concurrency, recovery, renderer, and extension-loading tests pass.
- [ ] README/architecture/UL/role instructions document escalation ladder and non-guarantees; coverage/risk analysis and final watcher gate pass.

## Out of scope

- Killing OS processes, undoing side effects, interrupting offline members, automatic watchdogs, role permissions, interrupt-all, or response waiting.

