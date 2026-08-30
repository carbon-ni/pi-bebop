---
id: TASK-0145
title: Prevent Follow-up delivery from stalling recipient agents
status: todo
depends_on: []
priority: high
tags: [follow-up, messaging, lifecycle, hang, regression, tdd]
---

# Prevent Follow-up delivery from stalling recipient agents

## Problem
When an ordinary Follow-up is sent to an active agent, the recipient can become stuck instead of completing its current turn and later processing the queued message. This blocks crew coordination and can prevent graceful lifecycle actions.

## Context

Observed during live Crew coordination: a Follow-up was accepted while the
recipient was active, but the recipient appeared to remain stuck and queued
lifecycle commands could not process. This observation establishes the symptom,
not causality. An accepted Follow-up does not prove target processing, and its
arrival may predate newer coordination.

Investigate the target run/message-delivery boundary before attributing the
stall to `send_follow_up` itself.

## Acceptance criteria

- [ ] A deterministic failing fixture reproduces the observed busy-recipient
      stall with bounded barriers or injected time, never wall-clock sleeps.
- [ ] Baseline control proves the same recipient run completes without a
      Follow-up; evidence identifies the first divergent state transition.
- [ ] Diagnosis records sender acknowledgement, target activity, queued-message
      state, turn-end handling, and next model delivery without exposing private
      prompts, socket paths, session IDs, or internal queue contents publicly.
- [ ] After the fix, a busy recipient completes its current turn normally; the
      Follow-up never interrupts or redirects it and is delivered exactly once
      at the next natural turn with content, instructions, Origin, mode, and
      FIFO order preserved.
- [ ] Idle delivery, one and multiple queued Follow-ups, delivery immediately
      around turn end, abort, reload, shutdown, offline, and delivery failure
      are bounded and leak-free with no deadlock, loss, duplication, false
      acknowledgement, or correlated-Response implication.
- [ ] Unchanged-path tests preserve Redirect and Member Request scheduling and
      correlation semantics.
- [ ] A real multi-runtime extension-host regression proves the recipient can
      return idle, consume the Follow-up once, complete the next turn, and then
      process a graceful lifecycle command.
- [ ] Focused tests, typecheck, formatting, architecture/package checks, full
      gates, fresh watcher, and independent exact-head QA pass.

## Non-goals

- Making Follow-up interrupt or redirect active work.
- Adding a Response requirement, progress inference, polling, forced endpoint
  release, or socket cleanup.
- Reopening TASK-0140 or changing TASK-0144 Request reminder semantics.

## Notes

Treat the live observation as regression input only until a deterministic
fixture proves causality.

