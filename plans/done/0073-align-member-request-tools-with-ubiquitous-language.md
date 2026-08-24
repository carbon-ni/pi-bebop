---
id: TASK-0073
title: Align member request tools with ubiquitous language
status: done
depends_on: [TASK-0071]
priority: high
tags: [ubiquitous-language, crew, messaging, response, tools, refactor, tdd]
---

# Align member request tools with ubiquitous language

## Problem

Correlated response behavior landed with provisional public terms that conflict
with `UL.md`: reply correlation is still documented as unsupported, **Member
request** and **Request outcome** are undefined, `request_member` can sound like
member selection, and `wait_for_crew_update` overstates its scope. Presence,
Member Status, Broadcast, and unrelated messages are not updates returned by
that tool.

## Context

Keep TASK-0068 and TASK-0071 closed as historical contract/implementation.
Perform one behavior-preserving follow-up vocabulary refactor.

Add canonical product terms:

- **Member request** — non-interrupting Member message that expects exactly one
  correlated Response before finite deadline. Accepted never means answered or
  completed.
- **Request outcome** — terminal result of one Member request: Response, idle
  without response, offline, or timeout. It is not progress stream or Crew
  activity.
- **Request ID** — opaque bounded identifier correlating Member request and
  Response; it is not Delivery ID, task ID, or proof of identity.

Adopt public tools:

```text
send_member_request({ member, message, instructions?, timeout_seconds? })
respond_to_member_request({ message, instructions?, request_id? })
wait_for_request_outcome()
```

`send_follow_up` remains canonical normal communication when Response is not
required. Do not retain aliases for provisional names because they were not an
approved released contract; one vocabulary should exist.

## Acceptance criteria

- [ ] Tests first characterize behavior under current provisional names, then assert semantic rename with no transport/state/lifecycle behavior change.
- [ ] `UL.md` defines Member request, Request outcome, and Request ID in canonical sections and adds them to Relationships.
- [ ] UL defines Response as assistant output correlated to one Member request; ordinary Follow-up has no implicit Response expectation.
- [ ] UL Idle/reply ambiguity states correlation is supported only through Member request workflow; Member Idle Wait still never proves Response or completion.
- [ ] Recommended verbs add `send_member_request`, `respond_to_member_request`, and `wait_for_request_outcome` with boundaries versus `send_follow_up` and `wait_for_member_idle`.
- [ ] Public tool names/labels/descriptions become `send_member_request` (“Send Member Request”), `respond_to_member_request` (“Respond to Member Request”), and `wait_for_request_outcome` (“Wait for Request Outcome”).
- [ ] Provisional public names `request_member` and `wait_for_crew_update` are removed without aliases, redirects, dual registration, deprecation warnings, or compatibility branches.
- [ ] Internal domain/application names use Member request and Request outcome rather than generic Crew update where product meaning is represented; transport-only names may remain technical when truly transport scoped.
- [ ] Empty-wait error becomes `no-pending-member-requests` or equally canonical explicit code; concurrent waiter remains `already-waiting` and refers to Request outcome wait in text.
- [ ] Membership context remains concise and tool-owned: ordinary Follow-up for information, Member request when Response required, Request outcome wait only when no immediate coordination action remains.
- [ ] Lead role instruction remains exactly intent-level: “Continue coordinating until no ready work or pending Member requests remain.”
- [ ] Rename workflow document to `docs/MEMBER-REQUEST-WORKFLOW.md`, update maintained links/examples/status, and remove “Crew Update” as feature name.
- [ ] Closed TASK-0068/TASK-0071 are not reopened or rewritten; TASK-0073 records vocabulary supersession and current docs/source become authoritative.
- [ ] Existing capacities, deadline, register-before-delivery, response-before-idle, atomic terminal arbitration, privacy, FIFO, cancellation, reload, and exactly-once behavior remain unchanged.
- [ ] Repository search outside historical reports/plans contains no stale provisional names or claim that reply correlation is unsupported.
- [ ] Tool registry/loading/membership-context/unit/integration/packaged tests and focused coverage pass; fresh final watcher gate is green with unchanged fingerprint.

## Out of scope

- Protocol behavior, new outcomes, CLI parity, durable requests, compatibility
  aliases, task tracking, or changing ordinary Follow-up/Member Idle Wait.

## Verification

- UL review first, then semantic rename preview/search.
- Focused tool/context/domain/integration/package tests.
- `rg` stale-term check and fresh final watcher gate.
