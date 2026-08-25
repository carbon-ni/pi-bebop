# Member Status

Member Status is an on-demand, privacy-safe coordination snapshot for one
configured crew member. It answers one honest question:

> Is the member's Pi runtime reachable and mechanically idle, busy, or
> compacting right now?

It does not inspect conversation to infer work, and it never exposes
self-reported intent or progress: if you need intent, progress, a report, or a
verdict, ask the member explicitly (for example with `send_member_request`).

> TASK-0046 defines the domain contract; TASK-0047 implements the `member.status`
> JSON-RPC method and the `get_member_status` tool.

## Signals

### Presence

Presence is endpoint reachability:

- `online` — configured endpoint responded at observation time;
- `offline` — configured endpoint could not be reached.

Online does not mean available, idle, healthy, or willing to accept work.

### Activity

Activity is live Pi control-flow state:

- `idle` — `ctx.isIdle()` reports runtime settled;
- `busy` — Pi is processing agent run, retry, compaction retry, or queued
  continuation;
- `compacting` — Pi is performing context maintenance; this is not available/idle.
- `unavailable` — member endpoint is offline, so no live state exists.

`hasPendingMessages` is separate mechanical boolean from
`ctx.hasPendingMessages()`. Neither signal claims productivity or task progress.
Member cannot manually choose Activity.

## Status contract

Online:

```json
{
	"member": { "name": "Bob", "role": "developer" },
	"presence": "online",
	"activity": "busy",
	"hasPendingMessages": true,
	"observedAt": "2026-08-23T12:03:00.000Z"
}
```

Offline:

```json
{
	"member": { "name": "Bob", "role": "developer" },
	"presence": "offline",
	"activity": "unavailable",
	"hasPendingMessages": "unavailable",
	"observedAt": "2026-08-23T12:03:00.000Z"
}
```

Status contract is closed. It cannot carry:

- messages, prompts, instructions, or tool calls/results;
- session ids, aliases, socket/filesystem paths;
- model/provider information;
- automatic task, Git, plan, review, or CI state;
- member-authored focus or progress notes.

## Interaction

Implemented tool:

```text
get_member_status({ member: "Bob" })
```

Only joined members may query another configured member. Query is one-shot,
finite-time (bounded probe plus 5s RPC timeout), and never starts, steers, or
interrupts the target turn; it never emits presence activity. Transport failure
for a configured endpoint is a compact offline result; malformed online peer
output is a protocol error. `/crew members` remains the reachability roster;
detailed status stays on demand.

Use `send_follow_up` without querying when timing does not matter—it is the safe
default behind active work. Status exists for coordination decisions, not
monitoring.
