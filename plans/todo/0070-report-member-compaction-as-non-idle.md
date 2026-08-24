---
id: TASK-0070
title: Report member compaction as non-idle
status: doing
depends_on: [TASK-0069, TASK-0061]
priority: high
tags: [crew, status, idle, compaction, lifecycle, protocol, tdd]
---

# Report member compaction as non-idle

## Problem
Bebop member status and idle waiting rely on ctx.isIdle(), so manual Pi compaction is reported as idle and can prematurely release an idle waiter.

## Context

Consume TASK-0069's authoritative `ctx.isCompacting()` snapshot and balanced
lifecycle. Compaction is live mechanical work, not idle and not inferred Focus.
Represent it explicitly so coordinators can distinguish model/tool execution
from context maintenance.

Member Activity becomes `idle | busy | compacting` with deterministic
precedence for an online member:

1. `compacting` when `ctx.isCompacting()` is true;
2. `busy` when compaction is false and `ctx.isIdle()` is false;
3. `idle` only when compaction is false and `ctx.isIdle()` is true.

Offline remains `unavailable`. Pending messages and Focus remain orthogonal.
No summary, reason, progress, prompt, or compaction content is exposed.

Member Idle Wait uses the same predicate. Its atomic initial snapshot returns
`already-idle` only for `isIdle && !isCompacting`. If compaction is active, the
wait stays registered. On balanced compaction end, re-evaluate the full
predicate and emit the existing one-shot settled outcome only if no agent run,
retry, queued continuation, or other compaction remains.

## Acceptance criteria

- [ ] Tests first reproduce status returning idle during manual compaction and idle wait prematurely returning `already-idle`.
- [ ] Online Member Status schema and formatting accept exactly `idle|busy|compacting`; offline activity remains exactly `unavailable`.
- [ ] Activity precedence is `compacting` over `busy` over `idle`, derived only from current Pi control-flow APIs at request time.
- [ ] `compacting` exposes no compaction kind/reason, percentage, summary, prompts, branch entries, model/provider data, paths, or inferred task state.
- [ ] Pending-message and Focus fields remain unchanged and orthogonal; compacting never implies task progress, health, availability, or completion.
- [ ] Member Idle Wait's atomic subscribe-and-snapshot returns `already-idle` only when `ctx.isIdle() && !ctx.isCompacting()`; active manual/auto compaction or branch summarization keeps the subscription pending.
- [ ] Agent settled and compaction-ended signals both re-evaluate the full idle predicate; exactly one terminal result wins against timeout, disconnect, cancellation, retry, queued continuation, and duplicate/out-of-order terminal events.
- [ ] Successful, cancelled, and failed compaction release a waiter only after Pi reports compaction false and the rest of runtime is idle; overflow retry never creates an intermediate idle result.
- [ ] Status protocol, tool renderer, README/architecture/UL, and TASK-0061 CLI output document and preserve the new closed activity value.
- [ ] Compatibility handling rejects an unknown future activity value as malformed response rather than coercing it to idle or busy.
- [ ] Deterministic domain, control-runtime, status flow/tool, idle-subscription, integration, and CLI tests cover manual/auto/overflow compaction, cancellation/failure, queued continuation, and privacy exclusions without sleeps.
- [ ] Upgrade the pinned Pi peer/dev dependency range to the first TASK-0069 release; do not import Pi internals or probe private controller fields.

## Out of scope

- Compaction progress/history, summary inspection, remote cancellation, changing
  compaction policy, or treating compacting as Focus/task state.

## Verification

- Run focused status, idle-wait, protocol, control-runtime, CLI, and extension-loading tests.
- Measure touched-code coverage and inspect protocol/schema change impact.
- Verify the packed extension against the minimum supported Pi version and run a fresh final watcher gate.

