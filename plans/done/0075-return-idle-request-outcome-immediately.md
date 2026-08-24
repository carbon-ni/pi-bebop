---
id: TASK-0075
title: Return idle request outcome immediately
status: done
depends_on: []
priority: high
tags: [member-request, idle, lifecycle, race, regression, tdd]
---

# Return idle request outcome immediately

## Problem

A lead waiting through `wait_for_request_outcome` can remain blocked after the
target member has processed a Member request, sent no correlated Response, and
become mechanically idle. This violates approved contract: target
`agent_settled` must immediately emit terminal `idle-without-response`; the
finite Request deadline starts before dispatch and is fallback only, never a
post-idle delay.

## Context

Preserve closed Request outcomes and deterministic ordering:

- correlated Response before settle → `response`;
- target settles after request entered model context, without Response →
  immediate `idle-without-response`;
- channel loss → `offline`;
- original pre-dispatch deadline → `timeout`.

Do not add grace period, polling, sleep, or second timer. Investigate real Pi
lifecycle wiring from request visibility through `agent_settled`, target inbound
registry, persistent RPC notification, source outcome registry, and waiting
tool. Unit tests that manually call settle are insufficient.

## Acceptance criteria

- [ ] Failing packaged/two-runtime integration reproduces: source sends Member request, target accepts it into model context, target emits no Response, target reaches real `agent_settled`, and source wait remains pending before fix.
- [ ] Test controls lifecycle with events/barriers and fake clock where needed; no wall-clock sleep or flaky timing assertion.
- [ ] Target already idle before request does not resolve new request: request is armed only after target `pi.sendMessage` acceptance, and pre-request/pre-context idle is ignored.
- [ ] First valid target `agent_settled` after arming emits exactly one `idle-without-response` notification immediately, before original deadline advances.
- [ ] If target settles before source calls `wait_for_request_outcome`, source buffers `idle-without-response` and later wait returns it immediately without another target lifecycle event.
- [ ] Source records terminal outcome once, releases an active `wait_for_request_outcome`, clears request timer/channel/listeners, and never later emits timeout/offline duplicate.
- [ ] Calling `wait_for_request_outcome` with no pending or buffered Member request fails immediately with `no-pending-member-requests`; it never samples another member's current idle state.
- [ ] Response sent before settled wins and idle is ignored; response/settled same-boundary ordering remains deterministic.
- [ ] Manual compaction cannot produce false idle; combined `ctx.isIdle() && !ctx.isCompacting()` remains required.
- [ ] Multiple inbound requests settle independently without one missing channel preventing others; one failure cannot leave remaining requests stuck.
- [ ] If target settled lifecycle was already missed due to registration/order race, fix ordering rather than sampling idle, polling, or adding grace.
- [ ] Total deadline still starts register-before-dispatch and covers delivery plus response lifecycle; this task does not move deadline to idle.
- [ ] Tool wording distinguishes immediate `idle-without-response` from `timeout` and never implies completion, failure, availability, or intent.
- [ ] Focused domain/application/RPC/Pi lifecycle/packaged tests and touched coverage pass; fresh final watcher gate is green.

## Out of scope

- Post-idle grace, late correlated Response after idle terminal, changing timeout
  duration, ordinary Follow-up correlation, task completion inference, or CLI
  Member request support.
