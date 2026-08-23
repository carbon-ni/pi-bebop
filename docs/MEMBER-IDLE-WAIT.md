# Member Idle Wait

Member Idle Wait is a one-shot coordination primitive for a coordinating crew
member: block, bounded and event-driven, until another configured member's Pi
becomes mechanically idle, goes offline, or the bounded deadline expires, then
resume and decide what to do when no reply arrived.

It answers one honest question: **has the target Pi settled to a mechanically
idle state?**

It does not answer: did the target see my message, is it done with my task, will
it reply, is it available, is it healthy/productive, or will it stay idle.

> TASK-0050 defines the domain contract (resolution, timeout bounds, terminal
> outcome contract, one-shot state race, capacity gate). The RPC subscription
> method and `wait_for_member_idle` tool are TASK-0051 and are not implemented
> by this task.

## Terminal outcomes

A wait terminates exactly once with one of:

| Outcome   | Meaning                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `idle`    | Target Pi settled; `already-idle` when idle at subscribe-and-snapshot, `became-idle` when it settled during the wait. |
| `offline` | Endpoint unreachable before the wait or went offline/restarted during the wait.                                       |
| `timeout` | Bounded deadline expired while the target remained busy. Expected coordination outcome, not task failure.             |

Result contains only configured name/role, the terminal outcome/disposition,
and the observation timestamp. No messages, Focus, prompts, tools, session
ids, aliases, paths, model data, or instructions.

## Idle is mechanical and momentary

Idle means Pi runtime settled after the active agent run, retry, compaction
retry, and queued continuation are exhausted (`agent_settled`). `agent_end`
alone is insufficient while any continuation remains. Idle is:

- NOT message acknowledgement;
- NOT response correlation (`send_follow_up(wait_for: "response")` remains
  unsupported until delivery-level response correlation can be proven; idle
  waiting must not approximate it);
- NOT task completion, availability, health, productivity, or a promise to
  remain idle.

## Lifecycle and race contract

1. Resolve exact configured target through current membership (exact name or
   unique role; roles grant no extra authority — any current joined member may
   wait for any other).
2. Open a one-shot target subscription.
3. Target atomically registers the subscription and snapshots `ctx.isIdle()` so
   an idle transition cannot be lost between separate check/subscribe calls.
4. Already idle → complete immediately with `idle/already-idle` and no
   lingering subscription. Otherwise complete once from `agent_settled`.
5. Disconnect/restart completes as `offline`; timeout/caller cancellation
   removes the subscription. Exactly one terminal outcome wins against settle,
   disconnect, timeout, and cancellation.

Unjoined, self, unknown, and ambiguous targets are rejected before any network
IO. Timeout is finite: default 300 seconds, accepted range 1-600 seconds.
Caller cancellation releases the local connection and remote subscription
promptly.

## Capacity and privacy

- Wait is transient and non-durable: no chat activity, Focus, history,
  dashboard, background polling, or automatic follow-up.
- Target enforces finite one-shot subscription capacity (8 per target) and
  rejects overflow explicitly; at most one active wait per target.
- The wait never starts, steers, interrupts, aborts, or sends guidance to the
  target turn.
- Result carries only identity, outcome/disposition, and timestamp; all other
  session data stays hidden.

## Relationship to other signals

- **Member Status** is an immediate one-shot snapshot; Member Idle Wait blocks
  until a mechanical state transition or deadline.
- **Presence** is endpoint reachability; it never implies idle or availability.
- **Follow-up** waits behind active work and is safe to use when timing does
  not matter; idle waiting is a coordination decision, not a delivery
  mechanism and never implies a response is coming.
