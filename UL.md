# Pi Ubiquitous Language

Scope: Pi Bebop, a project-local crew coordination extension.

## Product concepts

| Canonical term           | Definition                                                                                                                                                                   | Avoid                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Crew**                 | Trusted, project-local set of configured Pi members that may be independently online or offline.                                                                             | team, cluster, pool                                    |
| **Crew manifest**        | Authoritative file that defines crew members, roles, endpoints, instructions, and presence policy.                                                                           | config, registry                                       |
| **Member**               | Pi session that claims one identity configured by crew manifest.                                                                                                             | peer, agent, session when discussing crew identity     |
| **Current member**       | Member identity claimed by this Pi session.                                                                                                                                  | self, local agent                                      |
| **Role**                 | Descriptive routing label for member; unique role may identify message target.                                                                                               | permission, authority                                  |
| **Membership**           | Active relationship between Pi session and claimed crew member identity.                                                                                                     | connection, login                                      |
| **Member endpoint**      | Project socket path that identifies configured member and resolves to active runtime socket.                                                                                 | session ID, alias, socket when product meaning matters |
| **Presence**             | Last observed endpoint reachability of configured member.                                                                                                                    | availability, readiness, idle state                    |
| **Role instructions**    | Stable member guidance loaded when membership starts or restores.                                                                                                            | prompt, message instructions                           |
| **Message instructions** | Ordered guidance attached to one crew message.                                                                                                                               | role instructions                                      |
| **Crew Intake**          | One-way feature that accepts an external message for the crew and hands it durably to the configured crew contact.                                                           | inbox, broadcast, API gateway                          |
| **External actor**       | Local process or Pi session that sends a crew message without joined member identity.                                                                                        | crew member, authenticated caller                      |
| **Crew contact**         | Explicitly configured member selected by exact name, responsible for triaging Crew Intake messages; product owner is recommended for software crews but never inferred.      | lead by default, first online member                   |
| **Crew Broadcast**       | Internal durable fan-out initiated by a current joined member; the same message persists to every other configured member and is later handed to each as a normal Follow-up. | intake, shared inbox, redirect-all, team broadcast     |

## Collaboration language

| Canonical term            | Definition                                                                                                                          | Avoid                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Member message**        | Structured communication sent from current member to another crew member.                                                           | command, RPC, payload                                 |
| **Enqueue**               | Act of persisting an Inbox item for a member; succeeds without recipient liveness and never implies delivery, start, or completion. | send, deliver, assign                                 |
| **Follow-up**             | Normal online member message delivered after target finishes active work when target is busy.                                       | deferred, inbox, non-urgent                           |
| **Redirect**              | Explicit member message inserted into active work to change what target is doing now.                                               | immediate, steer in product-facing language           |
| **Inbox**                 | Durable per-member message queue accepted while recipient may be offline and handed to Pi later as normal follow-up.                | task board, workflow engine, mailbox UI               |
| **Inbox item**            | Persisted structured member message with stable identity for restart-safe handoff.                                                  | task, assignment state, completed work                |
| **External crew message** | Unverified one-way message accepted by Crew Intake and addressed to the configured crew contact through Inbox.                      | broadcast, authenticated request, task                |
| **Accepted**              | Target endpoint validated and live delivery request acknowledged.                                                                   | delivered, completed, persisted                       |
| **Persisted**             | Inbox item durably stored; it does not mean offered, started, completed, or answered.                                               | delivered, accepted                                   |
| **Handoff**               | Act of offering one Inbox item to the recipient Pi session as a normal Follow-up, recorded as durable typed session evidence.       | delivery, completion, processing                      |
| **Direct**                | Accepted message started target work while target was idle.                                                                         | synchronous                                           |
| **Queued**                | Accepted follow-up waits behind target active work in transient session queue.                                                      | inbox, pending response                               |
| **Redirected**            | Accepted redirect entered target active turn.                                                                                       | steered in product-facing language                    |
| **Response**              | Assistant output correlated to one member message.                                                                                  | turn end                                              |
| **Presence activity**     | Non-interrupting chat record that reports observed crew reachability changes.                                                       | notification when referring to model-visible activity |

## Transport language

| Canonical term      | Definition                                                                     | Avoid                                    |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| **Runtime socket**  | Global Unix socket owned by one running Bebop session.                         | member endpoint                          |
| **Endpoint claim**  | Safe publication of member endpoint to current runtime socket.                 | registration, authentication             |
| **Origin**          | Claimed attribution attached to message; never proof of identity or authority. | sender authentication                    |
| **Delivery intent** | Internal choice between follow-up and redirect semantics.                      | mode in product-facing APIs              |
| **Disposition**     | Acknowledged delivery outcome: direct, queued, or redirected.                  | status without qualification             |
| **Presence hint**   | Untrusted request that causes peer to probe member endpoint.                   | join event, authoritative presence event |

## Recommended agent-facing verbs

| Intent                                           | Recommended tool    | Why                                                                                                 |
| ------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------- |
| Send normal online crew communication            | `send_follow_up`    | Established Pi term for non-interrupting delivery; does not imply durable storage.                  |
| Change target active work now                    | `redirect_member`   | Names consequence and urgency, not transport timing.                                                |
| Leave durable message for online or offline peer | `send_to_inbox`     | Durable per-member queue; persists even if recipient offline.                                       |
| Durable fan-out to every other member            | `broadcast_to_crew` | One non-interrupting message persisted to every other member, later handed off as normal follow-up. |

`send_follow_up` is canonical normal delivery. `redirect_member` names the
consequence (changing active work), not transport timing. Legacy
`send_immediate` and overloaded `send_to_member` are removed: `send_to_member`
mixed send/read/clear with session/socket targeting and did not represent one
crew-domain action.

## Relationships

```text
Crew manifest defines Crew
Crew contains Members
Pi session claims Membership as Current member
Member is reached through Member endpoint
Current member sends Member message
Live Member message is either Follow-up or Redirect
Accepted live message has Direct, Queued, or Redirected disposition
Crew manifest explicitly selects Crew contact
Intake is disabled when manifest has no Crew contact
Crew Intake accepts External crew message and addresses configured Crew contact
Crew Intake persists External crew message through Inbox
Inbox persists Inbox items independently from endpoint presence
Crew Broadcast is initiated only by a Current joined member
Crew Broadcast excludes the sender by canonical member identity
Crew Broadcast persists the same message to every other member through Inbox
Each Crew Broadcast recipient receives own Inbox item through normal Follow-up
Inbox item is removed only after durable session evidence records its Handoff
Bebop hands Inbox item to Pi as normal Follow-up without managing recipient workflow
Presence observes Member endpoint; it does not prove availability
```

## Example dialogue

> Message Bob with task plan after current work.

Use `send_follow_up({ member: "Bob", message: "Implement TASK-0027" })`.

> Bob is working on wrong file; redirect him now.

Use `redirect_member({ member: "Bob", message: "Stop and inspect crew-manifest-store.ts first" })`.

> Bob is offline; leave TASK-0035 for his next idle period.

Use `send_to_inbox({ member: "Bob", message: "Implement TASK-0035" })`.

> Is Bob available?

Say: “Bob endpoint is online.” Presence proves reachability only, not availability.

## Flagged ambiguities

- **Crew Intake/inbox:** Crew Intake is external-facing feature; Inbox is durable per-member delivery mechanism it reuses.
- **Intake/contact fallback:** no configured contact means external intake is disabled; there is never a fallback to lead, product owner, first, or online member.
- **Crew/contact:** messaging crew does not broadcast; configured crew contact owns triage, not automatic acceptance or execution.
- **Broadcast/inbox:** Broadcast persists separate per-recipient copies through each member's Inbox; it is not a shared group mailbox and does not route or select a worker.
- **Broadcast/redirect:** Broadcast is non-interrupting and cannot change what a recipient is doing; redirect targets one member's active work explicitly.
- **Agent/session/member:** use _member_ for crew identity, _Pi session_ for runtime conversation, and _agent_ only for general actor.
- **Online/available:** online means endpoint reachable; it does not mean idle, ready, or responsive.
- **Accepted/persisted/delivered/completed:** accepted acknowledges live delivery request; persisted acknowledges durable inbox storage; neither proves work completed or response produced.
- **Follow-up/inbox:** follow-up requires online target and uses transient Pi delivery; inbox survives recipient downtime and restarts.
- **Follow-up:** in ordinary conversation it can mean another conversational message; in Bebop it specifically means safe queued delivery when target is busy.
- **Immediate:** does not reveal that message redirects active work; prefer _redirect_.
- **Instructions:** qualify as _role instructions_ or _message instructions_.
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
- `plans/done/0035-implement-trusted-durable-inbox-storage.md`
- `plans/done/0036-add-member-inbox-enqueue-operation-and-tool.md`
- `plans/done/0037-hand-inbox-messages-to-pi-follow-up-delivery.md`
- `plans/todo/0040-define-external-crew-intake-feature.md`
