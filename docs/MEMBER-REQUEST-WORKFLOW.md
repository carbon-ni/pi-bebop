# Member Request Workflow

Status: **available**.

This workflow extends the optional [Software Crew Workflow](SOFTWARE-CREW-WORKFLOW.md).
It coordinates a bounded Member request without treating mechanical idle as a
Response or implying completion, correctness, authority, or progress.

## Terms

- **Member request** — a non-interrupting Member message that expects exactly
  one correlated Response before a finite deadline. Accepted never means
  answered or completed.
- **Requester** — the transient per-request role of the member who sent a Member
  request and alone waits for its outcome. Not a Crew role or authority.
- **Responder** — the transient per-request role of the member who received a
  Member request and sends exactly one correlated Response. Not a Crew role or
  permission.
- **Response** — assistant output correlated to one Member request. Ordinary
  Follow-up has no implicit Response expectation.
- **Request outcome** — the correlated outcome of one outbound Member Request:
  Response, offline, one nonterminal pending-after-idle notice, or terminal
  max-wait. It is not a progress stream, task state, or Crew activity. Idle itself is NOT an
  outcome: the responder gets a short bounded post-idle grace to report.
- **Request ID** — an opaque bounded identifier correlating a Member request
  with its Response. It is not a Delivery ID, task ID, proof of identity, or
  authority credential.

## Lead instruction

> Continue coordinating until no ready work or pending Member requests remain.

Tools own remaining workflow through names, defaults, descriptions, and errors.
Do not copy protocol steps into lead role instructions.

## Tools

### Send Member Request

```text
send_member_request({
  member: "Bob",
  message: "Implement TASK-123 and report evidence or blocker."
})
```

Defaults:

- normal non-interrupting delivery;
- exactly one Response expected;
- no extra instructions;
- `timeout_seconds`: post-idle Response grace, integer 1-600, default 120.
  Starts once at the responder's first post-context idle; a Response during the
  grace wins.
- `max_wait_seconds`: absolute accepted-request safety, integer 60-7200,
  default 1800, strictly greater than `timeout_seconds`. Starts at accepted
  delivery; may truncate a late grace.
- return immediately after accepted delivery with an opaque Request ID.

Migration: the old provisional `timeout_seconds` (a pre-dispatch total
deadline, default 300) is now `max_wait_seconds`. Callers wanting the old
configured post-accept safety pass that value as `max_wait_seconds`; the fixed
5-second acceptance phase means it is not temporally identical (documented
breaking provisional-contract change). The 5-second acceptance window is the
`MEMBER_REQUEST_ACCEPT_DEADLINE_MS` constant and is never configurable.

Use ordinary `send_follow_up` when no Response is required. This avoids
silently creating pending Member requests for information-only communication.

### QA handoff (correct requester/responder pattern)

A QA request that needs a verdict is a Member request, not a Follow-up:

```text
# Requester (e.g. a developer):
send_member_request({ member: "Kelly", message: "QA the TASK-0076 changes and report a verdict or blocker" })
... no immediate coordination action remains ...
wait_for_request_outcome({ request_id: "<exact-request-id>" })
# requester-side; blocks until that Request reports an outcome

# Responder (Kelly): the inbound message is visibly marked [member request]
# with the opaque Request ID; she does the QA work, then:
respond_to_member_request({ message: "QA verdict: approved; gate green" })
```

Ordinary `send_follow_up` is information-only: it is marked `[follow-up]` with
no correlated Response expected, and its content is never heuristically parsed
or silently upgraded into a request.

### Respond to Member Request

```text
respond_to_member_request({
  message: "Implemented TASK-123. Tests pass; remaining risk is ..."
})
```

With one active inbound Member request, the tool selects it automatically. With
multiple, provide the opaque `request_id`. With none or an expired request, the
error directs the responder to use ordinary Follow-up. The requester callback
route is never public input.

### Wait for Request Outcome

```text
wait_for_request_outcome({ request_id: "<exact-request-id>" })
```

The required opaque `request_id` is the exact ID returned by
`send_member_request`; the tool never selects the oldest Request. It blocks
until that Request reports Response, Offline, one nonterminal
`pending-after-idle`, or terminal max-wait. An accepted inbound Bebop message
also releases the wait so the message can be consumed before waiting again;
this does not settle the Request. After a message wake or
`pending-after-idle`, call the tool again with the same ID. Do not send a
replacement solely because a wait ended. The wait is cancellable, has one
local waiter, and does not poll or return Presence, Member Status, Broadcast,
Inbox, or unrelated Crew activity.

## Request outcomes

Terminal outcomes: **Response**, **Offline**, and **Timeout max-wait**.
`pending-after-idle` is a one-shot nonterminal observation; mechanical idle
itself is not an outcome.

### Response

A Response includes the configured member, opaque Request ID, message, and
ordered instructions. It proves only that correlated assistant output was
received—not completion, correctness, verification, ownership, or task success.

### Awaiting Response (nonterminal, internal)

The responder's first post-context idle is a nonterminal, internal signal. It
arms the source's bounded Response grace, queues the responder's one-time
reminder with the original Request ID, and preserves the parked outbound slot.
A Response delivered before the grace, during the reminder, or during the grace
window always wins. The reminder is queued before the idle notification so a
broken channel never loses it, and is inert once the Request is terminal.

### Pending after idle

When the short post-idle grace expires without a Response, the source receives
one `pending-after-idle` observation. It is nonterminal: the Request, response
channel, and hard `max_wait_seconds` deadline remain active. Call
`wait_for_request_outcome` again with the same `request_id`; do not send a
replacement solely because the short wait ended. The notice cannot repeat.

### Offline

The request channel disconnected before a Response. Correlated requests are
transient. Consider reassigning or using `send_to_inbox` for durable delivery.
This does not prove the work failed or stopped.

### Timeout max-wait

The absolute accepted-request safety deadline (`max_wait_seconds`, default
1800s) expired before any Response; it may truncate a late grace. Consider
checking Member Status, reassigning, using `send_to_inbox`, or using
`redirect_member` when urgent. Timeout never retracts accepted work and does
not prove work stopped, failed, or completed.

## Parallel loop

1. Send `send_member_request` for each independent request requiring a Response.
2. Requests return after acceptance; one slow Member does not block delegation.
3. When no immediate coordination action remains, call
   `wait_for_request_outcome` with the exact `request_id`.
4. Handle the returned Request outcome and assign newly ready work.
5. Repeat until no ready work or pending Member requests remain.

Outcomes may arrive out of assignment order; opaque Request IDs preserve
correlation. In the same synchronous-handler boundary the priority is
`response > offline > hard-expiry > pending-after-idle > idle-signal`: a
complete Response beats a subsequent socket close, and a Response arriving
with the responder's first idle is accepted. Pending-after-idle never competes
with a Response and never closes the Request.

## Boundaries

- Roles do not grant permission; any joined Member may use this workflow.
- Correlation is transient coordination state, not durable task state or auth.
- Unrelated Follow-ups preserve Pi FIFO behavior.
- Member Idle Wait remains a mechanical timing primitive and never proves a
  Response, completion, progress, correctness, or availability.
- Bebop never infers completion, quality, ownership, or integration.
- `/auto` scheduling is outside Bebop's scope; Bebop does not pause or resume it.
