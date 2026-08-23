# Member Status

Member Status is an on-demand, privacy-safe coordination snapshot for one
configured crew member. It answers two different questions honestly:

1. Is member Pi runtime reachable and mechanically idle or busy?
2. What short crew-visible Focus has member explicitly chosen to publish?

It does not inspect conversation to infer work. Member Description is separate:
it is stable manifest-authored profile text, while Focus is dynamic
member-authored activity. Description is not returned implicitly by Member
Status.

> TASK-0046 defines domain contract. Query/focus tools and RPC integration are
> planned in TASK-0047 and are not implemented by this task.

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
- `unavailable` — member endpoint is offline, so no live state exists.

`hasPendingMessages` is separate mechanical boolean from
`ctx.hasPendingMessages()`. Neither signal claims productivity or task progress.
Member cannot manually choose Activity.

### Focus

Focus is optional member-authored public note, for example:

```text
Implementing Inbox enqueue
Investigating recovery ordering
Verifying external intake failures
```

Focus:

- is explicitly crew-visible;
- is self-reported and unverified;
- is one bounded, trimmed, single-line UTF-8 value;
- rejects blank, NUL, multiline, padded, or oversized values;
- remains until member updates or clears it;
- restores only for exact canonical member identity;
- never crosses to another member after leave/switch.

Do not publish secrets, credentials, private prompt content, customer data,
filesystem paths, or other sensitive information in Focus.

If no Focus is published, result says `unspecified`. If member offline, Focus
says `unavailable`; stale previous Focus is never presented as current.

## Status contract

Online with member-reported Focus:

```json
{
  "member": { "name": "Bob", "role": "developer" },
  "presence": "online",
  "activity": "busy",
  "hasPendingMessages": true,
  "focus": {
    "state": "reported",
    "text": "Implementing Inbox enqueue",
    "updatedAt": "2026-08-23T12:00:00.000Z"
  },
  "observedAt": "2026-08-23T12:03:00.000Z"
}
```

Online without Focus:

```json
{
  "member": { "name": "Bob", "role": "developer" },
  "presence": "online",
  "activity": "idle",
  "hasPendingMessages": false,
  "focus": { "state": "unspecified" },
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
  "focus": { "state": "unavailable" },
  "observedAt": "2026-08-23T12:03:00.000Z"
}
```

Status contract is closed. It cannot carry:

- messages, prompts, instructions, or tool calls/results;
- session ids, aliases, socket/filesystem paths;
- model/provider information;
- automatic task, Git, plan, review, or CI state.

## Focus persistence

Focus events use `bebop-member-focus` typed custom session entries that do not
participate in LLM context. TASK-0047 will persist the following data through
Pi `appendEntry`; TASK-0046 only defines and validates the data contract:

```json
{
  "version": 1,
  "memberIdentity": "/canonical/configured/member.sock",
  "action": "set",
  "focus": "Implementing status schema",
  "updatedAt": "2026-08-23T12:00:00.000Z"
}
```

Clear event omits `focus`:

```json
{
  "version": 1,
  "memberIdentity": "/canonical/configured/member.sock",
  "action": "clear",
  "updatedAt": "2026-08-23T12:05:00.000Z"
}
```

Restore walks active session branch backward and uses latest valid entry for
exact current member identity. Invalid, unrelated, or other-member entries are
ignored.

## Planned interaction

TASK-0047 proposes:

```text
get_member_status({ member: "Bob" })
update_member_focus({ action: "set", focus: "Implementing Inbox enqueue" })
update_member_focus({ action: "clear" })
```

Only joined members may query another configured member. Query is one-shot,
finite-time, and never starts, steers, or interrupts target turn. `/crew
members` remains reachability roster; detailed status stays on demand.

Use `send_follow_up` without querying when timing does not matter—it is safe
default behind active work. Status exists for coordination decisions, not
monitoring.
