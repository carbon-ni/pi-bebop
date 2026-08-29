# Member Request Workflow

Status: **available**.

Use the [STE100 profile](STYLE.md) when you edit this guide. Keep tool names, outcomes, and fixed values exact.

This workflow extends the optional [Software Crew Workflow](SOFTWARE-CREW-WORKFLOW.md). It coordinates one bounded Member request.

Mechanical idle is not a Response. A Response does not prove completion, correctness, authority, or progress.

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
- **Request outcome** — the oldest terminal outcome of one outbound Member
  request: Response, offline, timeout after idle, or timeout max-wait. It is
  not a progress stream, task state, or Crew activity. Idle itself is NOT an
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
wait_for_request_outcome()   # requester-side, returns the QA verdict or offline/timeout

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
wait_for_request_outcome()
```

No arguments. It returns the oldest terminal outbound Request outcome. It does
not poll and does not return Presence, Member Status, Broadcast, Inbox,
or unrelated Crew activity. It is requester-side only: call it after you sent
`send_member_request`, never to handle an inbound Member request or an ordinary
message. When no pending outbound Member request exists, it fails immediately
with `no-pending-member-requests` and recovery guidance (respond to any inbound
request, send a new request, or continue ready work). Waiting is only
appropriate when no immediate coordination action remains.

## Request outcomes

Terminal outcomes: **Response**, **Offline**, **Timeout after idle**, and
**Timeout max-wait**. Mechanical idle itself is NOT an outcome; see
_Awaiting Response_ below.

### Response

A Response includes the configured member, opaque Request ID, message, and
ordered instructions. It proves only that correlated assistant output was
received—not completion, correctness, verification, ownership, or task success.

### Awaiting Response (nonterminal, internal)

The responder's first post-context idle is a nonterminal, internal signal, never
an outcome. It arms the source's bounded Response grace, queues the responder's
one-time reminder with the original Request ID, and preserves the parked
outbound slot; the Request stays nonterminal until a terminal outcome arrives.
A Response delivered before the grace, during the reminder, or during the grace
window always wins. The reminder is queued before the idle notification so a
broken channel never loses it, and is inert once the Request is terminal. A
Response after the grace window is rejected as already-terminal.

### Offline

The request channel disconnected before a Response. Correlated requests are
transient. For delivery that must survive absence or restart, create a durable
Inbox message instead.

### Timeout after idle

The post-idle Response grace expired without a Response (default 120s). The
responder was idle-awaiting-response and the one-time reminder had already been
queued. Timeout never retracts accepted work and does not prove work stopped,
failed, or completed.

### Timeout max-wait

The absolute accepted-request safety deadline (`max_wait_seconds`, default
1800s) expired before any Response; it may truncate a late grace. Timeout never
retracts accepted work and does not prove work stopped, failed, or completed.

## Parallel loop

1. Send `send_member_request` for each independent request requiring a Response.
2. Requests return after acceptance; one slow Member does not block delegation.
3. When no immediate coordination action remains, call
   `wait_for_request_outcome`.
4. Handle the oldest Request outcome and assign newly ready work.
5. Repeat until no ready work or pending Member requests remain.

Outcomes may arrive out of assignment order; opaque Request IDs preserve
correlation. In the same synchronous-handler boundary the priority is
`response > offline > grace-expiry > hard-expiry > idle-signal`: a complete
Response beats a later socket close. Bebop accepts a Response that arrives with the responder's first idle. Idle is nonterminal and does not compete with Response. The `response-after-idle` reason applies only
to the exact tie where the grace-expiry and hard-expiry timers fire at the
same instant — never to a Response/idle boundary.

## Boundaries

- Roles do not grant permission; any joined Member may use this workflow.
- Correlation is transient coordination state, not durable task state or auth.
- Unrelated Follow-ups preserve Pi FIFO behavior.
- Member Idle Wait remains a mechanical timing primitive and never proves a
  Response, completion, progress, correctness, or availability.
- Bebop never infers completion, quality, ownership, or integration.
