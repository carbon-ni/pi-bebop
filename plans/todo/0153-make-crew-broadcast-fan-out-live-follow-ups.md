---
id: TASK-0153
title: Make Crew Broadcast fan out live Follow-ups
status: todo
depends_on: []
priority: high
tags: [crew, broadcast, follow-up, messaging, tools, cli, refactor, tdd]
---

# Make Crew Broadcast fan out live Follow-ups

## Problem

Crew Broadcast currently duplicates durable Inbox delivery even though
`send_to_inbox` already owns that capability. This blurs delivery intent and
prevents a member from sending one ordinary non-interrupting Follow-up to every
other live crew member.

## Desired outcome

`broadcast_to_crew` and `pi-bebop crew broadcast` provide one obvious group
form of Follow-up: fan one informational message out to every other configured
crew member without interrupting active work or writing Inbox items.

Broadcast remains a message intent, so recipients see `[broadcast]` provenance.
Follow-up is its delivery behavior: each live recipient receives the message at
the same lifecycle point as a targeted `send_follow_up`. An offline or
unreachable recipient is an explicit failed disposition. Agents use
`send_to_inbox` separately when they need durable delivery.

## Approved contract

- Recipient set is every other member in current trusted manifest, in manifest
  order. Sender is excluded by canonical member identity.
- Caller provides only message and ordered instructions. There is no member
  filter, delivery mode, urgency, waiting, fallback, or reply option.
- Every recipient is attempted independently through shared Follow-up delivery
  seam. One failure does not prevent later recipients from being attempted.
- Outcome reports manifest-order disposition for every recipient as delivered
  or failed, including stable failure reason where available. Partial delivery
  is never presented as complete success.
- Broadcast is transient. It creates no Inbox item, Inbox hint, broadcast item
  ID, persistence retry, or already-persisted outcome. Repeating command is new
  delivery and may produce duplicate messages.
- Broadcast never redirects or interrupts active work and never expects or
  aggregates a Response.

## Acceptance criteria

- [ ] TDD first characterizes current durable behavior, then replaces it with
      live Follow-up happy, offline, unreachable, partial-failure, and
      single-member paths.
- [ ] `broadcast_to_crew` remains joined-member-only and accepts exactly message
      plus ordered instructions.
- [ ] `pi-bebop crew broadcast` has same semantics and result contract as tool.
- [ ] Sender and origin are derived at execution time from current trusted
      membership; caller cannot spoof origin or select recipients.
- [ ] Fan-out excludes sender, preserves manifest order, attempts every other
      member once, and preserves ordered instructions.
- [ ] Busy recipients receive normal queued Follow-up behavior; broadcast never
      steers or interrupts their active turn.
- [ ] Offline, stale-socket, transport, and recipient-rejection failures are
      explicit per-recipient dispositions; one failure does not stop fan-out.
- [ ] All-delivered outcome is success; any failed disposition is a clear
      partial/failure outcome retaining successful recipient evidence.
- [ ] Recipient model context retains canonical `[broadcast]` kind, Crew Origin,
      Sent time, and Age-at-delivery behavior without exposing socket routes.
- [ ] No broadcast path opens, writes, probes capacity of, or hints any member
      Inbox. There is no automatic Inbox fallback.
- [ ] Obsolete durable-broadcast IDs, persistence application flow, RPC result
      fields, help text, and tool guidance are removed rather than preserved as
      a second mode. Inbox-specific code shared by `send_to_inbox` remains.
- [ ] README and `UL.md` distinguish transient Crew Broadcast from targeted
      Follow-up and durable Inbox delivery.
- [ ] Unit, real-wire multi-runtime, CLI/tool parity, package smoke, coverage,
      architecture, final watcher, and independent exact-head QA gates pass.

## Constraints

- Reuse Follow-up application/transport boundaries instead of duplicating live
  send logic inside tool, CLI, or Pi runtime adapters.
- Domain remains free of Pi runtime, socket, filesystem, and Inbox storage IO.
- Delivery acknowledgement means recipient accepted message for Follow-up; it
  does not prove model read, understanding, or action.

## Non-goals

- Durable or offline delivery, Inbox fallback, redirect-all, interrupt-all,
  response collection, arbitrary subsets, role filters, shared group turns,
  external broadcast, cross-project delivery, or exactly-once live messaging.

## Related history

TASK-0042, TASK-0043, and TASK-0064 defined durable Broadcast behavior that
this task deliberately replaces. `send_to_inbox` remains dedicated durable
one-recipient surface.

