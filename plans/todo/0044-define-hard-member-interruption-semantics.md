---
id: TASK-0044
title: Define hard member interruption semantics
status: todo
depends_on: [TASK-0033]
priority: high
tags: [crew, interrupt, recovery, lifecycle, ubiquitous-language]
---

# Define hard member interruption semantics

## Problem
Redirect messages only steer after current assistant turn finishes its tool calls; when a crew member is stuck or acting on invalid assumptions, another joined member needs a stronger operation that aborts active work and reliably introduces recovery guidance before older queued follow-ups.

## Context

Define **Member Interrupt** as internal live recovery operation stronger than Redirect:

```text
Follow-up  -> waits until agent finishes
Redirect   -> Pi steer: current assistant turn/tool calls finish, then guidance enters before next model call
Interrupt  -> abort active operation, then recovery guidance enters before queued follow-ups
```

Candidate tool: `interrupt_member({ member, message, instructions? })`.

Interrupt is destructive control, not urgency label. It may cancel abort-aware model/tool work but cannot undo completed or non-cooperative side effects. It must preserve explicit audit evidence of who interrupted whom and why. External actors, Inbox, Crew Intake, and Broadcast cannot invoke it.

Pi `ctx.abort()` is fire-and-forget; `waitForIdle()` is command-only and queued follow-ups complicate ordering. Characterize actual Pi 0.84.2 lifecycle before implementation: queue recovery steer before abort, abort then inject during `agent_end`, and persistence/reload windows. If no sequence proves recovery becomes next model-visible guidance ahead of older follow-ups, feature is blocked rather than approximated.

## Acceptance criteria

- [ ] `UL.md` defines Interrupt and distinguishes it from Redirect, Follow-up, Inbox, and shutdown.
- [ ] Only current joined member can interrupt another configured member; self, external, unjoined, unknown, ambiguous, and offline targets are rejected.
- [ ] Busy target contract is explicit: persist pending recovery evidence, request abort, then deliver recovery guidance before previously queued follow-ups.
- [ ] Idle race is deterministic: recovery starts directly without reporting an abort that did not occur.
- [ ] Successful acknowledgement meanings are defined separately for `interrupt-requested` and idle `direct`.
- [ ] One pending interrupt per target is allowed; concurrent later request is rejected rather than replacing first recovery guidance.
- [ ] Interrupted partial output/history remains visible; no session clear/rewind occurs.
- [ ] Documentation states abort is best-effort for abort-aware work and never rolls back filesystem, shell, network, or already completed side effects.
- [ ] Target chat/session records stable interrupt ID, derived crew origin, recovery message, abort request, and handoff evidence without exposing reply route.
- [ ] Crash/reload between persistence, abort, and recovery handoff has declared deterministic behavior and no silent guidance loss.
- [ ] Real Pi host characterization covers active model stream, running abort-aware tool, queued steer/follow-up, idle race, duplicate request, and reload.
- [ ] If Pi cannot prove recovery precedence over old follow-ups, task records blocker and no misleading public tool is registered.

## Out of scope

- Rollback, process kill, remote command reversal, interrupt-all/broadcast, external interruption, automatic anomaly detection, permissions by role, or guaranteed cancellation of non-cooperative tools.

