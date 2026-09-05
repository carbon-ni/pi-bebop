---
id: TASK-0178
title: Guarantee wait-idle reports the requested Member
status: doing
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

- [ ] A RED end-to-end characterization reproduces the reported target/result mismatch or identifies the exact boundary that makes it impossible with current code.
- [ ] Every successful and unsuccessful `member wait-idle <member>` result identifies the exact resolved target requested by the caller; another Member's event/status cannot satisfy or label the wait.
- [ ] Peer responses and subscription events are validated against the resolved canonical Member identity before winning terminal arbitration.
- [ ] A mismatched peer/event identity becomes a typed protocol/routing error and never renders as a valid result for the requested Member.
- [ ] Concurrent waits for Mary and Dave, duplicate names/roles, self-target, stale alias/session selection, endpoint reuse, offline, timeout, message wake, and cancellation are deterministic and covered.
- [ ] Same-boundary idle/message first-terminal ownership and all listener/timer/socket cleanup remain unchanged.
- [ ] Default output names product Crew/Member identity and contains no hidden session ID or runtime socket.
- [ ] Help/error text provides the corrected product-level command and does not advise selecting a source session as normal recovery.
- [ ] Focused host/integration tests and final gates pass on an unchanged exact HEAD.

## Non-goals

Crew-level aggregation, continuous monitoring, progress inference, or changing what mechanical idle means.
