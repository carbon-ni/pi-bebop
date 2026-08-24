# Correlated Crew Update Workflow

Status: **planned by TASK-0068; not available until TASK-0071 ships**.

This workflow extends the optional [Software Crew Workflow](SOFTWARE-CREW-WORKFLOW.md).
It keeps coordination moving without treating member idle as response or making
lead remember transport mechanics.

## Lead instruction

The whole lead-loop instruction is:

> Continue coordinating until no ready work or pending crew requests remain.

Tools own remaining workflow through names, defaults, descriptions, and errors.
Do not copy protocol steps into lead role instructions.

Before TASK-0071 ships, continue using current Follow-up/status/idle tools and
expect queued Follow-ups to become visible only in later Pi run. Tools below are
planned, not currently callable.

## Tool defaults

### Request response from member

```text
request_member({
  member: "Bob",
  message: "Implement TASK-123 and report evidence or blocker."
})
```

Defaults:

- normal non-interrupting delivery;
- response expected;
- no extra instructions;
- 300-second deadline;
- return immediately after accepted delivery with opaque request id.

Use ordinary `send_follow_up` when no response is required. This avoids silently
creating pending requests for notifications.

### Respond to request

```text
respond_to_member_request({
  message: "Implemented TASK-123. Tests pass; remaining risk is ..."
})
```

With one active inbound request, tool selects it automatically. With multiple,
error lists bounded request ids/requesters and asks for explicit `request_id`.
With none/expired, error tells responder to resend as ordinary Follow-up.
Requester callback route is never public input.

### Wait for next update

```text
wait_for_crew_update()
```

No member or request id is required. Tool returns first terminal update across
all pending requests. When none exist, it fails immediately and tells lead to
continue ready work or stop.

## Update outcomes

### Response

Response includes configured member, request id, message, and ordered
instructions. It is visible once through wait tool result. It proves response
was received—not completion, correctness, or verification.

### Idle without response

Request entered member model context and member settled without responding.
Lead may send ordinary Follow-up, inspect status if timing matters, reassign, or
escalate. Lead never marks work complete from idle.

### Offline

Target request channel disconnected before response. For delivery that must
survive absence/restart, create new durable Inbox message. Correlated requests
are transient.

### Timeout

Request deadline expired. Timeout never retracts already accepted work. Lead
uses normal escalation ladder rather than polling idle repeatedly.

## Parallel loop

1. Lead calls `request_member` for each independent request.
2. Requests return after acceptance; one slow member does not block delegation.
3. When no immediate coordination action remains, lead calls
   `wait_for_crew_update`.
4. Lead handles first update and assigns newly ready work.
5. Lead repeats until no ready work or pending requests remain.

Updates may arrive out of assignment order. Request identity preserves
correlation. Response wins if response and idle occur in same target lifecycle
boundary.

## Boundaries

- Roles do not grant permission; any joined member may use workflow.
- Correlation is transient transport state, not durable task state.
- Unrelated Follow-ups preserve Pi FIFO behavior.
- Member Idle Wait remains mechanical timing primitive, not response wait.
- Focus remains self-reported and unverified.
- Bebop never infers completion, quality, ownership, or integration.
