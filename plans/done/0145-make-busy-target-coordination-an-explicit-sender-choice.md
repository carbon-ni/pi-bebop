---
id: TASK-0145
title: Make busy-target coordination an explicit sender choice
status: done
depends_on: []
priority: high
tags: [messaging, busy, follow-up, member-request, redirect, inbox, ux, tdd]
---

# Make busy-target coordination an explicit sender choice

## Problem

A non-interrupting message can be accepted while its target Member is already
busy, leaving the sender with a hidden queued delivery and, for a Member
Request, later pending reminders. In this situation the useful fact is already
known: the target runtime is mechanically busy. Delaying that fact makes the
sender wait on the wrong delivery choice.

## Desired outcome

Initial transient coordination makes one explicit choice at the authoritative
target boundary:

- an idle target accepts direct delivery;
- a busy or compacting target accepts nothing and immediately reports
  `target-busy`;
- the result tells the sender to use `redirect_member` when the next model step
  must change urgently, or `send_to_inbox` for non-urgent durable delivery.

Bebop never infers urgency and never redirects or persists automatically. The
sender owns the second tool call.

## Context

This product direction replaces the earlier assumption that a busy Follow-up
must always queue behind active work. It also prevents a newly rejected Member
Request from creating a pending request whose sender is reminded later.

Busy is mechanical Pi Activity only. It does not prove progress, availability,
acknowledgement, willingness, or when the Member will become idle.

## Acceptance criteria

- [ ] Tests first cover initial `send_follow_up` and `send_member_request`
      delivery to idle, busy, compacting, offline, and racing targets.
- [ ] The target runtime decides activity and delivery atomically. The sender
      does not perform a separate status preflight that can race the send.
- [ ] Idle initial delivery remains exactly once and returns its existing direct
      acceptance without changing message content, ordered instructions,
      Origin, target identity, or Request correlation.
- [ ] Busy or compacting initial delivery returns the closed actionable code
      `target-busy`, does not report acceptance, and does not enqueue, steer,
      persist, start a target turn, or mutate the target session.
- [ ] A busy Member Request creates no Request ID, outbound/inbound request
      slot, reminder, grace timer, hard deadline, correlation callback, or later
      `wait_for_request_outcome` event.
- [ ] Busy recovery text presents exactly two intent-preserving choices:
      `redirect_member` when changing the target's next model step is urgent;
      otherwise `send_to_inbox` for durable non-interrupting delivery. It never
      claims either choice was made.
- [ ] Offline recovery directs durable delivery to `send_to_inbox` without
      treating offline as busy or availability.
- [ ] `redirect_member` remains an explicit steer and `send_to_inbox` remains an
      explicit durable write. Neither capability is called implicitly by a
      failed transient send.
- [ ] `respond_to_member_request` and already accepted Request Response,
      cancellation, idle-grace, max-wait, and requester-reminder semantics stay
      unchanged.
- [ ] Deterministic race tests prove exactly one outcome: direct acceptance or
      `target-busy`. No boundary can both deliver and reject, lose a delivered
      acknowledgement, duplicate a message, or leave a pending Request.
- [ ] Tool descriptions, actionable result details, CLI parity, architecture
      docs, and the communication ladder use the same urgent-redirect versus
      non-urgent-Inbox language.
- [ ] A bounded multi-runtime regression proves a busy recipient keeps its
      current work unchanged, receives no rejected message later, and can
      receive the sender's explicit Redirect or Inbox choice exactly once.
- [ ] Focused happy/unhappy tests, typecheck, formatting, architecture/package
      checks, full gates, a fresh exact-clean watcher fingerprint, and
      independent exact-head QA pass.

## Non-goals

- Inferring urgency, intent, progress, or availability from Activity.
- Automatically redirecting, persisting, retrying, polling, waiting for idle,
  interrupting, or aborting the target.
- Changing correlated Response delivery or any Request that was accepted while
  the target was idle.
- Preserving queued busy-target Follow-up behavior as a compatibility path.
- Diagnosing unrelated agent stalls that occur without a busy-target send.
