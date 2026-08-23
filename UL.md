# Pi Ubiquitous Language

Scope: Pi Bebop, a project-local crew coordination extension.

## Product concepts

| Canonical term | Definition | Avoid |
| --- | --- | --- |
| **Crew** | Trusted, project-local set of configured Pi members that may be independently online or offline. | team, cluster, pool |
| **Crew manifest** | Authoritative file that defines crew members, roles, endpoints, instructions, and presence policy. | config, registry |
| **Member** | Pi session that claims one identity configured by crew manifest. | peer, agent, session when discussing crew identity |
| **Current member** | Member identity claimed by this Pi session. | self, local agent |
| **Role** | Descriptive routing label for member; unique role may identify message target. | permission, authority |
| **Membership** | Active relationship between Pi session and claimed crew member identity. | connection, login |
| **Member endpoint** | Project socket path that identifies configured member and resolves to active runtime socket. | session ID, alias, socket when product meaning matters |
| **Presence** | Last observed endpoint reachability of configured member. | availability, readiness, idle state |
| **Role instructions** | Stable member guidance loaded when membership starts or restores. | prompt, message instructions |
| **Message instructions** | Ordered guidance attached to one crew message. | role instructions |

## Collaboration language

| Canonical term | Definition | Avoid |
| --- | --- | --- |
| **Member message** | Structured communication sent from current member to another crew member. | command, RPC, payload |
| **Follow-up** | Normal online member message delivered after target finishes active work when target is busy. | deferred, inbox, non-urgent |
| **Redirect** | Explicit member message inserted into active work to change what target is doing now. | immediate, steer in product-facing language |
| **Inbox** *(proposed)* | Durable per-member message queue accepted while recipient may be offline and handed to Pi later as normal follow-up. | task board, workflow engine, mailbox UI |
| **Inbox item** *(proposed)* | Persisted structured member message with stable identity for restart-safe handoff. | task, assignment state, completed work |
| **Accepted** | Target endpoint validated and live delivery request acknowledged. | delivered, completed, persisted |
| **Persisted** *(proposed)* | Inbox item durably stored; it does not mean offered, started, completed, or answered. | delivered, accepted |
| **Direct** | Accepted message started target work while target was idle. | synchronous |
| **Queued** | Accepted follow-up waits behind target active work in transient session queue. | inbox, pending response |
| **Redirected** | Accepted redirect entered target active turn. | steered in product-facing language |
| **Response** | Assistant output correlated to one member message. | turn end |
| **Presence activity** | Non-interrupting chat record that reports observed crew reachability changes. | notification when referring to model-visible activity |

## Transport language

| Canonical term | Definition | Avoid |
| --- | --- | --- |
| **Runtime socket** | Global Unix socket owned by one running Bebop session. | member endpoint |
| **Endpoint claim** | Safe publication of member endpoint to current runtime socket. | registration, authentication |
| **Origin** | Claimed attribution attached to message; never proof of identity or authority. | sender authentication |
| **Delivery intent** | Internal choice between follow-up and redirect semantics. | mode in product-facing APIs |
| **Disposition** | Acknowledged delivery outcome: direct, queued, or redirected. | status without qualification |
| **Presence hint** | Untrusted request that causes peer to probe member endpoint. | join event, authoritative presence event |

## Recommended agent-facing verbs

| Intent | Recommended tool | Why |
| --- | --- | --- |
| Send normal online crew communication | `send_follow_up` | Established Pi term for non-interrupting delivery; does not imply durable storage. |
| Change target active work now | `redirect_member` | Names consequence and urgency, not transport timing. |
| Leave durable message for online or offline peer *(proposed)* | `send_to_inbox` | Honest only once durable inbox contract exists. |

Current `send_follow_up` is canonical normal delivery. Current `send_immediate` describes timing but not that active work may be changed; prefer `redirect_member`. Current `send_to_member` is overloaded with send/read/clear and session/socket targeting; it does not represent one crew-domain action and should not remain a Bebop crew tool.

## Relationships

```text
Crew manifest defines Crew
Crew contains Members
Pi session claims Membership as Current member
Member is reached through Member endpoint
Current member sends Member message
Live Member message is either Follow-up or Redirect
Accepted live message has Direct, Queued, or Redirected disposition
Inbox persists Inbox items independently from endpoint presence
Bebop hands Inbox item to Pi as normal Follow-up without managing recipient workflow
Presence observes Member endpoint; it does not prove availability
```

## Example dialogue

> Message Bob with task plan after current work.

Use `send_follow_up({ member: "Bob", message: "Implement TASK-0027" })`.

> Bob is working on wrong file; redirect him now.

Use `redirect_member({ member: "Bob", message: "Stop and inspect crew-manifest-store.ts first" })`.

> Bob is offline; leave TASK-0035 for his next idle period.

After inbox exists, use `send_to_inbox({ member: "Bob", message: "Implement TASK-0035" })`.

> Is Bob available?

Say: “Bob endpoint is online.” Presence proves reachability only, not availability.

## Flagged ambiguities

- **Agent/session/member:** use *member* for crew identity, *Pi session* for runtime conversation, and *agent* only for general actor.
- **Online/available:** online means endpoint reachable; it does not mean idle, ready, or responsive.
- **Accepted/persisted/delivered/completed:** accepted acknowledges live delivery request; persisted acknowledges durable inbox storage; neither proves work completed or response produced.
- **Follow-up/inbox:** follow-up requires online target and uses transient Pi delivery; inbox survives recipient downtime and restarts.
- **Follow-up:** in ordinary conversation it can mean another conversational message; in Bebop it specifically means safe queued delivery when target is busy.
- **Immediate:** does not reveal that message redirects active work; prefer *redirect*.
- **Instructions:** qualify as *role instructions* or *message instructions*.
- **Socket/endpoint:** endpoint is product identity; socket is transport implementation.

## Sources

- Pi binary: `/run/current-system/sw/bin/pi`
- Session day analyzed: `2026-08-23`
- Relevant session: `01a02d42-d549-7397-b8eb-f9b04d77b1ee`
- `README.md`
- `docs/ARCHITECTURE.md`
- `src/tools/member-tool-adapter.ts`
- `src/tools/send-to-member.ts`
- `plans/done/0031-split-crew-follow-up-and-immediate-messaging-tools.md`
- `plans/todo/0033-align-crew-messaging-tool-names-with-delivery-intent.md`
- `plans/todo/0034-define-durable-member-inbox-semantics.md`
