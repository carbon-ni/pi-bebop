# Pi Ubiquitous Language

Scope: Pi Bebop, a project-local crew coordination extension.

## Product concepts

| Canonical term                  | Definition                                                                                                                                                                                                                                                                     | Avoid                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Crew**                        | Trusted, project-local set of configured Pi members that may be independently online or offline.                                                                                                                                                                               | team, cluster, pool                                     |
| **Crew manifest**               | Authoritative file that defines crew members, roles, endpoints, instructions, and presence policy.                                                                                                                                                                             | config, registry                                        |
| **Member**                      | Pi session that claims one identity configured by crew manifest.                                                                                                                                                                                                               | peer, agent, session when discussing crew identity      |
| **Current member**              | Member identity claimed by this Pi session.                                                                                                                                                                                                                                    | self, local agent                                       |
| **Role**                        | Descriptive routing label for member; unique role may identify message target.                                                                                                                                                                                                 | permission, authority                                   |
| **Membership**                  | Active relationship between Pi session and claimed crew member identity.                                                                                                                                                                                                       | connection, login                                       |
| **Member endpoint**             | Project socket path that identifies configured member and resolves to active runtime socket.                                                                                                                                                                                   | session ID, alias, socket when product meaning matters  |
| **Member Description**          | Stable manifest-authored, crew-visible specialty or responsibility summary; it is not current work, authority, or routing identity.                                                                                                                                            | role instructions, permission, search key               |
| **Presence**                    | Last observed endpoint reachability of configured member.                                                                                                                                                                                                                      | availability, readiness, idle state                     |
| **Member Status**               | One-shot privacy-safe snapshot combining Presence, live Activity, and pending-message signal.                                                                                                                                                                                  | monitoring, task progress, transcript summary           |
| **Member Idle Wait**            | One-shot coordination primitive that blocks the current run, bounded and event-driven, until a configured member's Pi settles to mechanical idle, goes offline, the bounded deadline expires, or an accepted Bebop message releases the wait under its original delivery mode. | waiting for a reply, monitoring, availability, presence |
| **Activity**                    | Mechanical live Pi runtime state: idle when settled, busy while processing/retrying/continuing, or unavailable while offline.                                                                                                                                                  | availability, productivity, manually claimed state      |
| **Role instructions**           | Stable member guidance loaded when membership starts or restores.                                                                                                                                                                                                              | prompt, message instructions                            |
| **Message instructions**        | Ordered guidance attached to one crew message.                                                                                                                                                                                                                                 | role instructions                                       |
| **Crew Intake**                 | One-way feature that accepts an external message for the crew and hands it durably to the configured crew contact.                                                                                                                                                             | inbox, broadcast, API gateway                           |
| **External actor**              | Local process or Pi session that sends a crew message without joined member identity.                                                                                                                                                                                          | crew member, authenticated caller                       |
| **Crew contact**                | Explicitly configured member selected by exact name, responsible for triaging Crew Intake messages; product owner is recommended for software crews but never inferred.                                                                                                        | lead by default, first online member                    |
| **Crew Broadcast**              | Internal durable fan-out initiated by a current joined member; the same message persists to every other configured member and is later handed to each as a normal Follow-up.                                                                                                   | intake, shared inbox, redirect-all, team broadcast      |
| **Member request**              | Non-interrupting Member message that expects exactly one correlated Response before a finite deadline; Accepted never means answered or completed.                                                                                                                             | task assignment, interrupt, progress stream             |
| **Requester**                   | Transient per-request role: the member who sent a Member request and alone waits for its Request outcome with wait_for_request_outcome. Not a Crew role, not authority.                                                                                                        | lead by default, owner, asker with polling              |
| **Responder**                   | Transient per-request role: the member who received a Member request and sends exactly one correlated Response with respond_to_member_request. Not a Crew role, not a permission.                                                                                              | assignee, worker, implied reporter                      |
| **Request outcome**             | Oldest terminal outcome of one outbound Member request: Response, offline, timeout after idle, or timeout max-wait. Idle itself is NOT an outcome: the responder gets a short bounded post-idle grace to report. It is not progress, task state, or Crew activity.             | monitoring, status, completion proof                    |
| **Request ID**                  | Opaque bounded identifier correlating one Member request with its Response; it is not a Delivery ID, task ID, proof of identity, or authority credential.                                                                                                                      | authentication, task ID, identity proof                 |
| **Crew work**                   | Visible communication, tool results, and project artifacts produced in Crew scope; Crew-readable by default after credentials/secrets are redacted. Hidden model reasoning is unavailable.                                                                                     | Activity, productivity, private Member dossier          |
| **Crew Agreement**              | One observable collaboration instruction shared by every Member of one Crew. It is not project guidance, Role instructions, Message instructions, task state, or permission.                                                                                                   | law, charter, policy permission                         |
| **Current Crew Agreements**     | Exact activated Crew Agreement revision loaded as one stable Membership instruction snapshot for every Member.                                                                                                                                                                 | latest proposal, hot-reloaded instructions              |
| **Trial Agreement**             | Current Crew Agreement marked for mandatory review at the next Crew Retrospective; it remains current until a later Agreement revision is activated.                                                                                                                           | temporary message, unactivated proposal                 |
| **Agreement proposal**          | Attributed candidate add, amend, or remove operation supported by optional Retrospective evidence. It is not current instruction or activation authority.                                                                                                                      | decision, vote, accepted agreement                      |
| **Agreement revision**          | Immutable candidate, activated, or superseded version of Crew Agreements based on one exact Current Crew Agreements revision.                                                                                                                                                  | mutable draft file, Response                            |
| **Agreement activation**        | Explicit trusted project operation that atomically makes one candidate Agreement revision current after validating its exact base; no Role, Origin, facilitator, or Member message grants this authority.                                                                      | Accepted, approval message, Member permission           |
| **Agreement activation notice** | System-produced bounded Inbox notification enqueued for every configured Member after durable Agreement activation. It is informational, not Crew Broadcast, and not the activation source.                                                                                    | Crew Broadcast, activation, hot reload                  |
| **Crew Retrospective**          | Bounded, durable coordination round in which every configured Member reviews the same Crew Retrospective Record and Current/Trial Agreements; it may produce no change or one candidate Agreement revision.                                                                    | background monitoring, automatic meeting, activation    |
| **Retrospective facilitator**   | Exact configured Member coordinating one Crew Retrospective. Facilitator is not a Role, permission, activation authority, or fallback selected by Presence/Activity.                                                                                                           | product/lead by default, approver                       |
| **Retrospective evidence**      | Immutable bounded provenance-linked record from visible Crew work for one fixed interval. It is neither interpretation, completion proof, nor Agreement activation authority.                                                                                                  | surveillance, opinion, truth verdict                    |
| **Member retrospective report** | One Member's bounded attributed Response about their visible Crew work in the fixed Retrospective interval. Missing, offline, timeout, malformed, and late remain explicit outcomes.                                                                                           | hidden reasoning, facilitator-authored substitute       |
| **Retrospective situation**     | Evidence-backed collaboration occurrence selected for discussion, with factual summary separate from candidate interpretation and Agreement proposal.                                                                                                                          | automatic finding, Agreement, performance judgment      |
| **Crew Retrospective Record**   | Immutable bounded record with one evidence index and evidence-backed situations, shared with every configured Member using the same identity, content hash, and bytes.                                                                                                         | transcript dump, mutable agenda, consensus              |

## Collaboration language

| Canonical term            | Definition                                                                                                                                                                                       | Avoid                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Member message**        | Structured communication sent from current member to another crew member.                                                                                                                        | command, RPC, payload                                 |
| **Enqueue**               | Act of persisting an Inbox item for a member; succeeds without recipient liveness and never implies delivery, start, or completion.                                                              | send, deliver, assign                                 |
| **Follow-up**             | Normal online member message delivered after target finishes active work when target is busy.                                                                                                    | deferred, inbox, non-urgent                           |
| **Redirect**              | Explicit member message inserted into active work to change what target is doing now.                                                                                                            | immediate, steer in product-facing language           |
| **Interrupt**             | Destructive internal live recovery operation that requests best-effort abort and puts persisted recovery guidance ahead of older queued Follow-ups; it never rewinds or rolls back side effects. | redirect, shutdown, kill, rollback                    |
| **Inbox**                 | Durable per-member message queue accepted while recipient may be offline and handed to Pi later as normal follow-up.                                                                             | task board, workflow engine, mailbox UI               |
| **Inbox item**            | Persisted structured member message with stable identity for restart-safe handoff.                                                                                                               | task, assignment state, completed work                |
| **External crew message** | Unverified one-way message accepted by Crew Intake and addressed to the configured crew contact through Inbox.                                                                                   | broadcast, authenticated request, task                |
| **Accepted**              | Target endpoint validated and live delivery request acknowledged.                                                                                                                                | delivered, completed, persisted                       |
| **Persisted**             | Inbox item durably stored; it does not mean offered, started, completed, or answered.                                                                                                            | delivered, accepted                                   |
| **Handoff**               | Act of offering one Inbox item to the recipient Pi session as a normal Follow-up, recorded as durable typed session evidence.                                                                    | delivery, completion, processing                      |
| **Direct**                | Accepted message started target work while target was idle.                                                                                                                                      | synchronous                                           |
| **Queued**                | Accepted follow-up waits behind target active work in transient session queue.                                                                                                                   | inbox, pending response                               |
| **Redirected**            | Accepted redirect entered target active turn.                                                                                                                                                    | steered in product-facing language                    |
| **Response**              | Assistant output correlated to exactly one Member request. Ordinary Follow-up has no implicit Response expectation.                                                                              | turn end, completion proof                            |
| **Presence activity**     | Non-interrupting chat record that reports observed crew reachability changes.                                                                                                                    | notification when referring to model-visible activity |

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

| Intent                                                                                                                                                   | Recommended tool            | Why                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send normal online crew communication                                                                                                                    | `send_follow_up`            | Established Pi term for non-interrupting delivery; does not imply durable storage.                                                                                                                |
| Change target active work now                                                                                                                            | `redirect_member`           | Names consequence and urgency, not transport timing.                                                                                                                                              |
| Abort target active work for recovery                                                                                                                    | `interrupt_member`          | Live target-owned recovery: evidence, best-effort abort, then recovery steer; never rolls back side effects.                                                                                      |
| Leave durable message for online or offline peer                                                                                                         | `send_to_inbox`             | Durable per-member queue; persists even if recipient offline.                                                                                                                                     |
| Durable fan-out to every other member                                                                                                                    | `broadcast_to_crew`         | One non-interrupting message persisted to every other member, later handed off as normal follow-up.                                                                                               |
| Inspect one member timing                                                                                                                                | `get_member_status`         | Returns reachability, mechanical Activity, and pending signal without reading conversation.                                                                                                       |
| Send a Member request requiring one Response                                                                                                             | `send_member_request`       | Requester-side: accepted non-interrupting delivery with opaque Request ID; the sender alone waits for its outcome.                                                                                |
| Respond to a Member request                                                                                                                              | `respond_to_member_request` | Responder-side: correlates one Response using active request context or opaque Request ID; only for an inbound Member request, never ordinary Follow-up.                                          |
| Wait for the oldest terminal outbound Request outcome                                                                                                    | `wait_for_request_outcome`  | Requester-side: call only after you sent a Member request; no arguments, no polling, no inbound handling, no unrelated activity; only Response, offline, timeout after idle, or timeout max-wait. |
| Block this run until another member's Pi is mechanically idle, goes offline, the bounded timeout expires, or an accepted Bebop message releases the wait | `wait_for_member_idle`      | One-shot bounded blocking wait; message-received never implies reply, idle, task completion, or availability. Request-outcome waiting remains yielding.                                           |

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
Current member sends a Member request when exactly one Response is required
Member request carries an opaque Request ID
Response correlates to exactly one Member request
Request outcome is the oldest terminal outbound outcome, not unrelated Crew activity
Crew Broadcast persists the same message to every other member through Inbox
Each Crew Broadcast recipient receives own Inbox item through normal Follow-up
Inbox item is removed only after durable session evidence records its Handoff
Bebop hands Inbox item to Pi as normal Follow-up without managing recipient workflow
Presence observes Member endpoint; it does not prove availability
Member Status reads Presence and live Activity without triggering target turn
Offline Member Status marks Activity unavailable rather than stale
Busy Interrupt persists pending recovery, requests abort, then hands recovery guidance before older queued Follow-ups
Crew work contributes bounded Retrospective evidence for one fixed interval
Bebop coordination, repository work, and Member retrospective reports contribute Retrospective evidence
Crew Retrospective lifecycle is not-due -> due -> open -> completed
Bebop alone detects due from injected clock/cadence; due never starts a round
Persisted due marker wins over later clock rollback until exact round opens/completes
Exact Retrospective facilitator starts and coordinates; explicit takeover names exact Member and due marker/open round
Crew Retrospective start freezes roster, interval, and exact Current Crew Agreements revision
Retrospective evidence supports Retrospective situations without becoming interpretation or Agreement proposal
Crew Retrospective Record is immutable and shared byte-identically with every configured Member
Member review confirms, corrects, or disputes situations; silence, timeout, and offline never imply agreement
Crew Retrospective produces no change or one candidate Agreement revision
Trial Agreement has explicit retain-trial/graduate/amend/remove review result and never expires automatically
Agreement revision references one exact Current Crew Agreements base revision
Only trusted project operation performs Agreement activation
Agreement activation changes Current Crew Agreements atomically and never hot-reloads active Memberships
Agreement activation notice is enqueued through every configured Member Inbox and is not Crew Broadcast
Next Membership join/restore loads the exact Current Crew Agreements snapshot
```

## Example dialogue

> Message Bob with task plan after current work.

Use `send_follow_up({ member: "Bob", message: "Implement TASK-0027" })`.

> Bob is working on wrong file; redirect him now.

Use `redirect_member({ member: "Bob", message: "Stop and inspect crew-manifest-store.ts first" })`.

> Bob is offline; leave TASK-0035 for his next idle period.

Use `send_to_inbox({ member: "Bob", message: "Implement TASK-0035" })`.

> Is Bob idle?

After Member Status is implemented, use `get_member_status({ member: "Bob" })`. Treat Activity as mechanical; ask Bob explicitly for intent or progress.

> Is Bob available?

Say: “Bob endpoint is online.” Presence proves reachability only, not availability.

## Flagged ambiguities

- **Crew Intake/inbox:** Crew Intake is external-facing feature; Inbox is durable per-member delivery mechanism it reuses.
- **Intake/contact fallback:** no configured contact means external intake is disabled; there is never a fallback to lead, product owner, first, or online member.
- **Crew/contact:** messaging crew does not broadcast; configured crew contact owns triage, not automatic acceptance or execution.
- **Crew contact/lead:** contact is the manifest-selected member triaging external Crew Intake; it is not lead, manager, authority, default internal recipient, or permission. Internal member communication still targets an exact member name or unique role.
- **Broadcast/inbox:** Broadcast persists separate per-recipient copies through each member's Inbox; it is not a shared group mailbox and does not route or select a worker.
- **Broadcast/redirect:** Broadcast is non-interrupting and cannot change what a recipient is doing; redirect targets one member's active work explicitly.
- **Agent/session/member:** use _member_ for crew identity, _Pi session_ for runtime conversation, and _agent_ only for general actor.
- **Presence/Activity:** Presence says reachable; Activity says Pi idle/busy. Neither means available, healthy, or productive.
- **Activity/progress:** Activity is mechanically derived and cannot be claimed; it never proves task progress.
- **Online/available:** online means endpoint reachable; it does not mean idle, ready, or responsive.
- **Idle/reply:** mechanical idle proves only that the Pi runtime settled; it never proves the target saw a message, finished a task, intends to reply, or will remain idle. Response correlation is supported only through the Member request workflow.
- **Idle wait/monitoring:** idle wait is one-shot, transient, and bounded; monitoring is continuous background observation.
- **Idle wait/Member Status:** Member Status is an immediate snapshot; idle wait blocks until a mechanical transition or deadline.
- **Accepted/persisted/delivered/completed:** accepted acknowledges live delivery request; persisted acknowledges durable inbox storage; neither proves work completed or Response produced.
- **Member request/Follow-up:** a Member request expects exactly one correlated Response; ordinary Follow-up has no implicit Response expectation.
- **Request outcome/activity:** Request outcome wait returns only the oldest terminal outbound Member request outcome; it never monitors or returns unrelated Crew activity.
- **Follow-up/inbox:** follow-up requires online target and uses transient Pi delivery; inbox survives recipient downtime and restarts.
- **Follow-up:** in ordinary conversation it can mean another conversational message; in Bebop it specifically means safe queued delivery when target is busy.
- **Interrupt/Redirect/Follow-up/Inbox/shutdown:** Follow-up waits; Redirect changes direction after current assistant tool calls without aborting; Inbox persists for later or offline handoff; Interrupt requests best-effort abort and recovery precedence; shutdown ends the runtime and is not message delivery or recovery.
- **Immediate:** does not reveal that message redirects active work; prefer _redirect_.
- **Instructions:** qualify as _role instructions_ or _message instructions_.
- **Description/Role instructions:** Member Description is stable manifest-authored profile text; Role instructions are behavioral guidance and are not a public profile. Descriptions must not contain secrets, credentials, customer data, or private prompt content.
- **Crew work/Activity:** Crew work is visible collaboration evidence and artifacts; Activity is only live mechanical Pi state. Neither mechanically proves productivity, intent, quality, or completion.
- **Crew transparency/security:** visible Crew work is Crew-readable by default; credentials/secrets are redacted and hidden model reasoning is unavailable. This security boundary does not create private Member work inside the Crew.
- **Evidence/interpretation/proposal:** Retrospective evidence records what a source exposed; Retrospective situation labels candidate interpretation separately; Agreement proposal suggests a change. None implies the next stage or activation.
- **Agreement/common/Role/Message instructions:** Crew Agreements are Crew-evolved shared collaboration instructions; common Crew instructions are stable operator-authored foundations; Role instructions apply to one Member; Message instructions apply to one message. Ordering does not imply override authority.
- **Facilitator/Role/authority:** Retrospective facilitator is one exact configured Member coordinating one round. It is not a Role, permission, approver, activation authority, or liveness fallback.
- **Activation/Accepted:** Agreement activation is an atomic trusted project operation; Accepted remains only live delivery acknowledgement. Never call an Agreement revision Accepted.
- **Activation notice/Crew Broadcast/Inbox:** Agreement activation notice is system-produced per-Member Inbox fan-out after activation. Crew Broadcast requires a Current member initiator. Inbox supplies durability; neither notification operation activates Agreements.
- **Current Agreements/hot reload:** Agreement activation changes durable Current Crew Agreements; active Membership instruction snapshots remain unchanged until join/restore/rejoin.
- **Retrospective Record/consensus:** every configured Member reviews the same immutable record, but identical evidence does not imply identical interpretation, consent, or unanimous consensus.
- **Retrospective due/open/completed:** due is a persisted cadence result and reminder only; exact facilitator explicitly starts one open round; facilitator explicitly completes it with no change or one candidate revision. None performs Agreement activation.
- **Late/correction/new evidence:** on-time correction appends an attributed annotation without rewriting the frozen record. Late Response content and newly supplied post-freeze evidence carry to the next round and cannot affect the current candidate revision.
- **Trial/review/expiration:** each reviewed Trial Agreement records retain-trial, graduate, amend, or remove. It remains Current and reappears until a revision containing another result is activated; no automatic expiration.
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
- `plans/todo/0044-define-hard-member-interruption-semantics.md`
- `plans/todo/0048-add-crew-visible-member-descriptions.md`
- `plans/todo/0046-define-member-activity-and-public-focus-status.md`
- `docs/MEMBER-STATUS.md`
- `docs/CREW-AGREEMENTS.md`
- `plans/todo/0103-define-crew-agreements-and-crew-retrospective-contract.md`
