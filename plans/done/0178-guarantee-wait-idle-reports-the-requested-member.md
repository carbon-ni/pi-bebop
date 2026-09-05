---
id: TASK-0178
title: Guarantee wait-idle reports the requested Member
status: done
depends_on: []
priority: high
tags: [cli, member-idle, identity, routing, correctness, regression, tdd]
---

# Guarantee wait-idle reports the requested Member

## Problem

A user asked for `member wait-idle Mary` and received an outcome naming Dave. A coordination wait that can report another Member undermines target identity and makes every wait result unsafe to trust.

## Priority

P0 correctness investigation. Do not wait for the Commander or name-routing refactors.

## Acceptance criteria

- [x] A RED end-to-end characterization reproduces the reported target/result mismatch or identifies the exact boundary that makes it impossible with current code.
- [x] Every successful and unsuccessful `member wait-idle <member>` result identifies the exact resolved target requested by the caller; another Member's event/status cannot satisfy or label the wait.
- [x] Peer responses and subscription events are validated against the resolved canonical Member identity before winning terminal arbitration.
- [x] A mismatched peer/event identity becomes a typed protocol/routing error and never renders as a valid result for the requested Member.
- [x] Concurrent waits for Mary and Dave, duplicate names/roles, self-target, stale alias/session selection, endpoint reuse, offline, timeout, message wake, and cancellation are deterministic and covered.
- [x] Same-boundary idle/message first-terminal ownership and all listener/timer/socket cleanup remain unchanged.
- [x] Default output names product Crew/Member identity and contains no hidden session ID or runtime socket.
- [x] Help/error text provides the corrected product-level command and does not advise selecting a source session as normal recovery.
- [x] Focused host/integration tests and final gates pass on an unchanged exact HEAD.

## Evidence

- Root cause: `handleMemberIdleWait` watched source membership instead of resolving/proxying `command.member`.
- Implementation: `e148f23`, `fdb795a`, and `8530214`; independent boundary fix/review: `e982481`.
- Real Unix-socket CLI/RPC regression proves asking for Mary never returns source Member Dave.
- Canonical name and role are validated at RPC client, application flow, and tool boundary; mismatch is typed and hidden from success output.
- Focused 107/107 passed; external final watcher generation 915 passed on unchanged HEAD.

## Non-goals

Crew-level aggregation, continuous monitoring, progress inference, or changing what mechanical idle means.
