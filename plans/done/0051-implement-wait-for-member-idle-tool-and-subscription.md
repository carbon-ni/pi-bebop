---
id: TASK-0051
title: Implement wait-for-member-idle tool and subscription
status: done
depends_on: [TASK-0047,TASK-0050]
priority: high
tags: [crew, activity, idle, tools, rpc, subscription, lifecycle]
---

# Implement wait-for-member-idle tool and subscription

## Problem
After idle/activity semantics and live status RPC exist, joined members need a token-efficient one-shot tool that blocks without polling the model, resumes on target idle/offline/timeout, and never reads or triggers the target conversation.

## Context

Implement TASK-0050 contract after TASK-0047 establishes live Activity/status protocol. Prefer extending existing one-shot subscription/event transport rather than client polling. Tool stays membership-scoped through TASK-0049, so independent/unjoined Pi sessions pay no tool-schema cost.

Public surface:

```text
wait_for_member_idle({ member: "Bob", timeout_seconds?: 300 })
```

Tool blocks current caller tool execution but makes no repeated LLM calls. When terminal event arrives, normal tool result resumes caller agent so it can decide whether to send Follow-up, Redirect, Interrupt, or do nothing. Bebop does not choose reaction.

## Implementation approach

1. Add failing pure contract/reducer tests for terminal outcome race and strict privacy schema.
2. Extend schema-validated RPC with one-shot idle subscription and bounded terminal event; preserve command correlation and malformed-frame isolation.
3. Make subscription registration plus initial `ctx.isIdle()` snapshot atomic at target control runtime.
4. Emit idle only from Pi `agent_settled`; wire disconnect/reload/shutdown cleanup and capacity limits.
5. Add request-scoped application operation for membership target resolution, endpoint connection, timeout, cancellation, and outcome mapping.
6. Register concise `wait_for_member_idle` tool with only `member` and optional bounded integer `timeout_seconds`.
7. Add real Pi lifecycle characterization for busy stream/tool/retry/compaction/queued continuation before declaring `became-idle` ordering proven.
8. Document use in lead convention as example, never role permission or reply correlation.

## Acceptance criteria

- [x] Tool schema has only `member` and optional integer `timeout_seconds` (1–600, default 300) and is active only while joined.
- [x] Application operation rejects unjoined, self, unknown, and ambiguous target before transport IO using existing member resolution semantics.
- [x] Target registration atomically stores one-shot subscription and samples `ctx.isIdle()`; already idle completes directly without leak.
- [x] Busy wait completes from `agent_settled`, not `agent_end` or `turn_end`, after all retry/compaction/queued continuation work.
- [x] Exactly one of idle, offline, timeout, or cancellation wins under deterministic race tests; later events are ignored.
- [x] Offline before connect and disconnect/restart during wait produce bounded offline result; no automatic resubscription.
- [x] Timeout produces normal expected outcome; caller AbortSignal cancels socket wait and removes remote subscription promptly.
- [x] Remote runtime caps concurrent idle subscriptions with named limit and explicit capacity error; all terminal paths release entries/listeners/timers.
- [x] Result schema and text expose only member name/role, outcome/disposition, and observation timestamp.
- [x] Target receives no model-visible message and wait never triggers, steers, redirects, interrupts, or aborts target.
- [x] Existing send, interrupt, status, turn-end subscription, Presence, and Inbox protocol behavior remains unchanged.
- [x] Unit/integration tests cover already idle, busy→settled, pending continuation, timeout, cancellation, offline/disconnect, reload/shutdown, capacity, malformed commands/events, duplicate terminal events, and target ambiguity.
- [x] Real Pi host characterization proves `agent_settled` ordering for model stream, abort-aware tool, retry/compaction, and queued Follow-up.
- [x] Documentation explicitly says no response correlation/task completion/availability inference and caller chooses any reaction.
- [x] Coverage/risk analysis and fresh final watcher gate pass.

## Out of scope

- Durable watches, background monitoring, wait-any/wait-all, arbitrary predicates, automatic escalation, reply correlation, task state, external access, role permissions, polling implementation, or TASK-0046/0047 behavior changes beyond required integration seam.

