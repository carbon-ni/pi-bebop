---
id: TASK-0121
title: Implement /crew member-idle command adapter
status: doing
depends_on: [TASK-0118, TASK-0120]
priority: high
tags: [crew, idle, command, selection, pi-api, lifecycle, tdd]
---

# Implement `/crew member-idle` command adapter

## Problem

Human operators need a slash command for selected idle observation without starting or impersonating a Lead turn. The command must parse exact names, reuse the Crew Idle Gate core, remain bounded, and respect Pi command lifecycle without claiming agent-tool equivalence where scheduling differs.

## Public surface

```text
/crew member-idle
/crew member-idle Dave,Kelly
```

Omission selects every other configured Member. Explicit comma-separated values select exact Member names and normalize to manifest order.

## Implementation plan

1. Add failing pure parser/selection tests before extending `/crew` grammar and completions.
2. Add a Pi command adapter around TASK-0118's injected Crew Idle Gate operation; do not duplicate target, round, deadline, ordering, or result rules in `src/pi/`.
3. Characterize Pi 0.84.3 command behavior for idle/busy start, long async handler, local activity, reload/session replacement/shutdown, notification/entry rendering, and absence of active command AbortSignal.
4. Own one lifecycle AbortController per active command, registered before remote IO and cancelled exactly once by local activity or session teardown.
5. Render compact progress/result through TUI status/custom entry only; clear progress on every terminal and never submit a user/custom model message.
6. Keep command inactive/unavailable while unjoined and reject trust/membership/selection errors before probes.

## Acceptance criteria

- [ ] TDD covers both successful forms and every unhappy parser/lifecycle path before adapter implementation.
- [ ] `/crew` parser accepts exact `member-idle` action with omitted list or one comma-separated tail; current actions and quoted join/agreements/inbox parsing remain unchanged.
- [ ] Surrounding whitespace and names containing spaces work; empty/trailing/doubled segments, duplicates, self, unknown, Role labels, unsafe byte bounds, and comma-bearing exact-name ambiguity reject atomically before endpoint IO.
- [ ] Argument completion exposes `member-idle` and configured exact names without leaking paths, roles as authority, session IDs, or hidden state.
- [ ] Omitted selection and explicit selection produce the same normalized target set/results as the agent tool for shared mechanical inputs.
- [ ] Busy/compacting/pending local Pi rejects command start immediately with actionable guidance; command never waits silently for local idle.
- [ ] Idle start acquires one local capacity slot before target IO. Concurrent Member Idle Wait, agent Crew gate, or second command rejects without sharing/replacing/cancelling owner.
- [ ] Later local agent activity cancels only command observation with `local-activity`; inbound message/run remains unchanged and command does not apply agent-tool `message-received`/`terminate` semantics.
- [ ] Slash observation owns no `crew-idle` Blocking-wait marker and never returns `wait-lock`, even for full-roster selection; remote blocking waits remain non-ready mechanical observations.
- [ ] Reload, new/resume/fork, leave, stop, shutdown, timeout, offline, unstable, partial setup, protocol failure, and thrown renderer/notify errors release controllers/subscriptions/status exactly once.
- [ ] Command result is bounded TUI-only output with scope, frozen manifest-order identities, mechanical outcome/timestamps, and honest selected-vs-all wording; no model context entry or automatic turn is created.
- [ ] Command never calls `sendUserMessage`, `sendMessage`, Redirect, Interrupt, abort on another Member, or any task-routing operation.
- [ ] Real Pi host characterization proves async handler scheduling, `ctx.signal` absence, local activity cancellation, and no model/provider call from command result.
- [ ] Existing `/crew join|leave|members|status|inbox|agreements|stop`, lifecycle, tool activation, and command autocomplete tests remain green.
- [ ] Focused tests, typecheck, format, architecture/package checks, clean hooks, and fresh watcher pass.

## Out of scope

- Triggering Lead action after command, standalone CLI parity, persistent monitoring, Role/pattern selection, automatic recovery, remote-run mutation, or changing agent-tool message consumption.
