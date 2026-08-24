# Member Request Workflow

Status: **available**.

This workflow extends the optional [Software Crew Workflow](SOFTWARE-CREW-WORKFLOW.md).
It coordinates a bounded Member request without treating mechanical idle as a
Response or implying completion, correctness, authority, or progress.

## Terms

- **Member request** — a non-interrupting Member message that expects exactly
  one correlated Response before a finite deadline. Accepted never means
  answered or completed.
- **Response** — assistant output correlated to one Member request. Ordinary
  Follow-up has no implicit Response expectation.
- **Request outcome** — the oldest terminal outcome of one outbound Member
  request: Response, idle without Response, offline, or timeout. It is not a
  progress stream, task state, or Crew activity.
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
- 300-second deadline;
- return immediately after accepted delivery with an opaque Request ID.

Use ordinary `send_follow_up` when no Response is required. This avoids
silently creating pending Member requests for information-only communication.

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
not poll and does not return Presence, Member Status, Focus, Broadcast, Inbox,
or unrelated Crew activity. When no pending Member request exists, it fails
immediately. Waiting is only appropriate when no immediate coordination action
remains.

## Request outcomes

### Response

A Response includes the configured member, opaque Request ID, message, and
ordered instructions. It proves only that correlated assistant output was
received—not completion, correctness, verification, ownership, or task success.

### Idle without Response

The Member request entered the target model context and the target Pi settled
without a Response. It proves neither that work finished nor that a Response
will follow. Do not infer progress or completion from it.

### Offline

The request channel disconnected before a Response. Correlated requests are
transient. For delivery that must survive absence or restart, create a durable
Inbox message instead.

### Timeout

The finite Request deadline expired. Timeout never retracts accepted work and
does not prove work stopped, failed, or completed.

## Parallel loop

1. Send `send_member_request` for each independent request requiring a Response.
2. Requests return after acceptance; one slow Member does not block delegation.
3. When no immediate coordination action remains, call
   `wait_for_request_outcome`.
4. Handle the oldest Request outcome and assign newly ready work.
5. Repeat until no ready work or pending Member requests remain.

Outcomes may arrive out of assignment order; opaque Request IDs preserve
correlation. Response wins if Response and idle occur in the same target
lifecycle boundary.

## Boundaries

- Roles do not grant permission; any joined Member may use this workflow.
- Correlation is transient coordination state, not durable task state or auth.
- Unrelated Follow-ups preserve Pi FIFO behavior.
- Member Idle Wait remains a mechanical timing primitive and never proves a
  Response, completion, progress, correctness, or availability.
- Focus remains self-reported and unverified.
- Bebop never infers completion, quality, ownership, or integration.
