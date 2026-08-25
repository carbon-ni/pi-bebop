---
id: TASK-0080
title: Implement Response wait and auto suspension
status: doing
depends_on: [TASK-0079, TASK-0081]
priority: high
tags: [member-request, response, idle, timeout, auto, lifecycle, tdd]
---

# Implement Response wait and auto suspension

## Problem

Implement approved correlated Request outcome contract end to end. Current
yielding Request-outcome code parks waits but does not suspend `pi-auto`, so
`/auto "wait or continue"` repeats same wait before terminal event. Current
Request state also closes at idle instead of giving responder one reminder and
bounded post-idle Response window. TASK-0081 separately supersedes Member Idle
Wait with blocking-until-idle-or-message behavior.

## Context

Treat current uncommitted yielding-wait implementation as provisional. Preserve
useful pure/runtime seams, but change behavior to approved state machine rather
than layering sleeps or prompt workarounds. Cross-extension integration uses
Pi shared `pi.events`; Bebop must work when pi-auto absent.

## Acceptance criteria

- [ ] TDD reproduces observed transcript: auto iteration parks Bob idle wait, run settles, next auto iteration repeats and parks another wait before terminal event.
- [ ] Pure Member request state/timers implement accepted-working, idle-awaiting-response, Response, offline, grace-timeout, and max-wait-timeout transitions from TASK-0079.
- [ ] RPC protocol carries nonterminal idle-awaiting-response separately from terminal outcomes and includes closed timeout reason without exposing routes.
- [ ] Target emits first post-context idle signal once, retains inbound request/channel, and queues one structured responder reminder; subsequent settles do not duplicate reminder or restart grace.
- [ ] Fixed 5-second acceptance deadline leaves no slot/timer on failure; source starts 120-second default grace from idle signal and 1,800-second default hard timer from acceptance; injected fake timers prove exact cleanup/race order and hard truncation.
- [ ] `send_member_request` schema/help exposes grace `timeout_seconds` (1–600) and hard `max_wait_seconds` (60–7200, strictly greater than grace) with approved defaults and stable validation before IO.
- [ ] Request outcome yielding resumes only for Response, offline, response-after-idle timeout, or max-wait timeout; idle signal alone never resumes requester.
- [ ] Remove public terminal `idle-without-response` from domain schema, renderer, tool details, UL/docs, and tests.
- [ ] `wait_for_member_idle` remains mechanically independent and follows TASK-0081 blocking idle-or-inbound-message contract; it never enters Request-outcome parked/resume events.
- [ ] Yield registry rejects or reuses semantic duplicate wait by session+kind+target/request and never arms duplicate remote subscription/timer.
- [ ] Bebop emits exact `pi-bebop:wait-parked`, `wait-resume-queued`, `wait-resume-started`, `wait-resume-settled`, and `wait-cancelled` events with `{waitId,kind}` only; semantic duplicates emit no event.
- [ ] pi-auto optionally tracks disjoint live/outcome-pending Wait-ID sets, preserves remaining iterations/message, and sends nothing while either set is nonempty.
- [ ] Bebop binds `resume-started` to the exact outcome turn entering context and emits `resume-settled` only for that turn; unrelated settlements never unpause auto, and cancellation needs no outcome settle.
- [ ] Cancel/session shutdown clears suspension consistently; stale safety in pi-auto remains bounded and never silently sends while confirmed Bebop wait is live.
- [ ] Two-runtime integration covers mutual nested Member requests, target already idle before request, Response before idle, Response after reminder, grace timeout, hard timeout, offline, busy-run buffering, and auto loop preservation without sleeps.
- [ ] Terminal-before-reminder delivery drops unaccepted guidance; FIFO-accepted late guidance remains ordered but tombstone makes Response return `no-active-request` without Request-state mutation.
- [ ] Negative tests prove no pi-auto listener does not break Bebop; other event names, malformed payloads, and unknown Wait IDs cannot consume waits. Exact-name/live-ID publication is documented as unauthenticated process-local coordination.
- [ ] Request-outcome tool/result wording says parked/suspended rather than implying completed yield; Member Idle Wait wording follows TASK-0081 blocking semantics; lead loop `wait or continue` does not repeat either wait.
- [ ] Package manifests include new runtime files; focused coverage and both repositories' final gates pass from unchanged worktree fingerprints.

## Out of scope

- Auto-stopping loop, changing auto message/count semantics, CLI request workflow,
  durable requests, task inference, or new Crew permissions.
