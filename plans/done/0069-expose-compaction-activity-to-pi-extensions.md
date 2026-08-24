---
id: TASK-0069
title: Expose compaction activity to Pi extensions
status: done
depends_on: []
priority: high
tags: [pi-api, extensions, compaction, lifecycle, activity, tdd]
---

# Expose compaction activity to Pi extensions

## Problem
Pi ExtensionContext reports manual compaction as idle and exposes no balanced compaction lifecycle, so extensions cannot authoritatively distinguish a session that is compacting from one that is mechanically available.

## Context

Pi 0.84.2 exposes `AgentSession.isCompacting` and includes `isCompacting` in
RPC `get_state`, but `ExtensionContext` exposes only `isIdle()`. `isIdle()` is
implemented from the active agent-run flag. Auto-compaction runs inside that
flag, while manual `/compact` does not, so manual compaction is observable as
idle through the extension API.

Existing extension events cannot form a safe workaround:
`session_before_compact` announces the attempt and `session_compact` reports
only successful persisted summaries. Cancellation and failure have no balanced
terminal extension event, so an extension-maintained latch can remain stuck.

Add read-only compaction state to `ExtensionContext` and balanced lifecycle
events. Preserve `session_compact` as the successful-summary event. The new
terminal event describes lifecycle only and must fire for success,
cancellation, and failure without exposing summary or conversation content.

## Acceptance criteria

- [ ] Tests first reproduce manual compaction with `ctx.isIdle() === true` and prove new `ctx.isCompacting() === true` for the full operation.
- [ ] `ExtensionContext` and its runner actions expose `isCompacting(): boolean`, backed by the current `AgentSession.isCompacting` source of truth; stale contexts reject consistently with existing context methods.
- [ ] `isCompacting()` is true for manual, threshold, and overflow compaction and branch summarization exactly while their existing abort controller is active; it is false before start and after every terminal path.
- [ ] Add balanced extension lifecycle events carrying bounded metadata only: start includes operation kind/reason and retry intent; end includes the same identity plus `succeeded|cancelled|failed` and retry intent.
- [ ] Start fires exactly once only after `isCompacting()` becomes true; end fires exactly once only after it becomes false, including extension cancellation, caller abort, provider failure, and successful extension-provided or Pi-generated summary.
- [ ] Existing `session_before_compact` cancellation/customization and successful `session_compact` contracts remain compatible; the new lifecycle event does not duplicate summary content.
- [ ] Event payloads expose no prompts, branch entries, generated summary, model credentials, provider payload, or session path.
- [ ] `ctx.isIdle()` semantics remain backward compatible in this task; documentation tells availability-sensitive extensions to require `ctx.isIdle() && !ctx.isCompacting()`.
- [ ] `ctx.waitForIdle()` documentation and tests state whether manual compaction/branch summarization is included; if its implementation currently resolves during either, fix it to wait until both activity sources settle.
- [ ] Deterministic tests cover manual success/failure/cancel, auto threshold success, overflow retry, branch-summary success/failure, stale context, handler ordering, and exactly-once terminal emission without wall-clock sleeps.
- [ ] Extension docs and one minimal example show an activity snapshot and lifecycle subscription without maintaining an inferred latch.

## Out of scope

- Exposing summary content, changing compaction policy/settings, or adding
  product-specific crew/member concepts to Pi.

## Delivery boundary

This task lands in the Pi coding-agent package and must publish a compatible
version before TASK-0070 upgrades and consumes the API.

