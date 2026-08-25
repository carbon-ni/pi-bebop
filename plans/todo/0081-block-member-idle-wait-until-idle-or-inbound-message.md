---
id: TASK-0081
title: Block Member Idle Wait until idle or inbound message
status: doing
depends_on: [TASK-0079]
priority: high
tags: [member-idle, auto, messaging, lifecycle]
---

# Block Member Idle Wait until idle or inbound message

## Problem

Yielding `wait_for_member_idle` lets Lead run settle, so current `/auto` may send
another iteration before target becomes idle. User wants this specific tool to
keep Lead run pending. It must release deterministically when target becomes
idle or an inbound Bebop message needs to enter Lead context.

## Product delta

This supersedes TASK-0079 only for **Member Idle Wait**. Correlated Request
outcome waiting remains yielding and keeps its parked/resume event lifecycle.

`wait_for_member_idle` once again awaits one blocking promise. While pending,
Pi run remains busy and pi-auto's existing `sendPending` gate naturally blocks
next auto iteration.

First atomic terminal wins:

```text
target already idle        -> already-idle
target later agent_settled -> became-idle
target endpoint closes     -> offline
bounded deadline           -> timeout
accepted inbound Bebop message -> message-received
requester abort            -> aborted
```

`message-received` is a neutral wake reason, not an error or claim about target.
It cancels target idle subscription before tool resolves. Accepted inbound
message stays in Pi FIFO and enters context as queued continuation after tool
returns; it is never inspected, removed, duplicated, or reordered.

“Inbound message” means a structured message accepted through Bebop's local
message-delivery path (Follow-up, Redirect, Member request/Response, Inbox,
Broadcast, or equivalent `send` delivery). It does not claim visibility into
arbitrary messages injected by unrelated extensions. Human abort remains its
own explicit path.

Same synchronous boundary priority:

```text
message-received > became-idle > offline > timeout
```

Even if idle wins first, later accepted message remains FIFO queued and is not
lost. Only winning outcome resolves tool; all other listeners/timers/socket
subscriptions clean up exactly once.

## Auto behavior

- No Bebop parked-wait event is emitted for blocking Member Idle Wait.
- `/auto` has already sent current iteration, so `sendPending` stays true while
  tool promise is pending.
- On idle/offline/timeout, tool returns in same Lead turn; Lead processes result,
  then full run settles; auto may send next preserved iteration.
- On inbound Bebop message, tool returns neutral wake result; queued message is
  processed before `agent_settled`; auto continues only after that continuation
  settles.
- Member Idle Wait does not create a later `crew-wait-resume` outcome turn.

## Accepted tradeoff

Two members simultaneously blocking on each other's idle cannot themselves
reach `agent_settled`; they wait for inbound message, offline, abort, or bounded
timeout. This is deliberate consequence of requested blocking semantics and
must be documented rather than hidden by polling or heuristic completion.

## Acceptance criteria

- [ ] TDD proves tool execution promise stays pending while target is busy and no inbound Bebop message arrives.
- [ ] Existing pi-auto sends no second iteration while blocking tool remains pending, without new cross-extension suspension event.
- [ ] Already-idle, became-idle, offline, timeout, message-received, and abort each resolve once with deterministic fake barriers/clocks.
- [ ] Inbound message atomically cancels idle subscription, resolves neutral wake, stays FIFO queued, and is processed before Lead `agent_settled`.
- [ ] Same-boundary message wins idle; idle winning just before message never drops queued message.
- [ ] All timers, socket listeners, and local message-wake listeners clean up once on every path.
- [ ] Remove Member Idle Wait use of `YieldingWaitRuntime`, `crew-wait-resume`, and parked/resume shared events; Request outcome yielding remains unchanged.
- [ ] No polling, sleeps, private Pi queue mutation, message-content parsing, task inference, or selective FIFO removal.
- [ ] Mutual blocking limitation and inbound-message scope are explicit in tool help and workflow docs.
- [ ] Focused real-socket integration proves busy target → inbound Follow-up wake and busy target → `agent_settled` wake.
- [ ] Fresh Bebop and pi-auto gates pass with unchanged-worktree proof.

## Out of scope

- Making arbitrary third-party extension messages observable.
- Changing `wait_for_request_outcome`.
- Inferring task completion from idle or message arrival.
