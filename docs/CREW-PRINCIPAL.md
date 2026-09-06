# Crew Principal outbound contact contract

Status: normative product contract for TASK-0182. Transport and CLI implementation are deferred.

## Promise

A Crew may send a one-way update to an explicitly configured external Principal without exposing session IDs, sockets, or pi-intray commands. The route proves only that the destination is the configured Principal route. It does not make the Principal a Member, Guest, Requester, Responder, or authority.

A Principal message is never a request for a Response. The Crew may know that a message was persisted or handed to the route; it must not claim that the Principal read, understood, approved, or acted on it.

## Canonical terms

- **Crew Principal** is the external person, service, or Pi process that a Crew explicitly configures as an outbound contact. Principal is a product recipient term, not a permission or command-authority term.
- **Principal identity** is the manifest-authored stable identity expected at that contact. It is attribution and destination selection, not authentication of every message received from that party.
- **Principal contact** is the Crew policy that enables outbound messages to one Principal identity. It is distinct from **Crew contact**, which is the exact Member who triages external Crew Intake.
- **Principal route binding** is the application-owned binding between one Principal identity and one approved destination. It contains opaque route material outside the Crew manifest and normal output. It authorizes receipt at that route only.
- **Principal message** is a one-way outbound message attributed to the sending Crew and, when permitted, the exact sending Member. It has no implicit Response, task, approval, or membership semantics.

A Principal can be an External actor in another interaction, but a Principal contact never authenticates an External actor and never upgrades its authority. A route binding is not a Member endpoint, Runtime socket, Guest capability, Request ID, session alias, or credential visible to the model.

## Product boundary

| Direction | Product feature | Authority | Guarantee |
| --- | --- | --- | --- |
| External actor → Crew | Crew Intake | none beyond one-way Intake | persisted for the manifest-authored Crew contact, when configured |
| Authorized Crew sender → Principal | Principal contact | manifest policy only | bounded one-way delivery state; no Response |
| Current Member or approved Guest → Crew/Member Target | Ask | joined Member or approved Guest route | one correlated Response or one terminal Ask outcome |
| Member → Member | Inbox | current Member delivery authority | durable per-member Inbox item and later handoff |

Principal contact is not Crew Intake in reverse. It is not Ask, Member Request, Member message, Crew Broadcast, Guest membership, or an Inbox item. An implementation may use a dedicated bounded Principal outbox, but it must not expose the internal queue as an Inbox or imply that a Principal is a Crew participant.

## Configuration and authorization

The optional manifest block is explicit and versioned. A proposed v2 shape is:

```yaml
principalContact:
  identity: "coordinator.example/alpha"
  displayName: "External coordinator"
  routeBinding:
    kind: "approved-destination"
  allowedSenders:
    - "Mony"
  delivery:
    maxMessageBytes: 65536
    retention: "7d"
```

The exact schema belongs to implementation, but these semantics are fixed:

- `identity`, `displayName`, the route-binding method, the exact `allowedSenders`, and bounded delivery policy are manifest-authored. `identity` is stable and case-sensitive; `displayName` is presentation only.
- `allowedSenders` is an explicit list of configured Member names. An empty or absent list denies all Crew senders. No lead, role, Crew contact, first Member, online Member, current operator, environment variable, session alias, or previous recipient is inferred.
- Route-binding material, destination endpoint, capability, session ID, socket, network address, and secret are never stored in the manifest or shown in ordinary output. A separate trusted binding operation creates or rotates that material and records only safe binding state.
- Absence of `principalContact` disables outbound Principal contact. It does not fall back to Crew Intake, Crew contact, a local Member, or a previously used destination.
- A sender must be the current joined Member named in `allowedSenders`. Guests, External actors, standalone CLI processes, and Members not listed there are rejected before message content is persisted.
- The first implementation uses one durable, FIFO Principal outbox. A caller cannot select a transport, retry policy, destination, retention, or route. Policy bounds are validated before enqueue.

### Migration

Existing raw `pi -p --intray --control-session ... --send-session-message ...` usage is not a Principal contact and is never auto-imported. Migration is explicit: add the versioned manifest policy, bind the expected Principal through the approved binding flow, and choose allowed Member names. Existing session aliases, runtime sockets, environment variables, and previous recipients provide no migration input. An unsupported manifest version fails closed with a corrected setup command.

## Message and privacy contract

Every Principal message carries these product fields internally:

- Crew Selector and Crew display name from the trusted manifest;
- exact sending Member name when the sender is a Member;
- Principal identity and display name;
- sent time and bounded nonnegative age at handoff;
- stable message identity for idempotent retry;
- one-way guarantee and terminal delivery state.

Origin remains attribution, never authentication. A Principal route does not make Principal-originated content trusted, and a Principal message does not grant the recipient Crew instructions or authority.

Default text, TOON, and JSON output expose only product identity, guarantee state, and freshness. They do not expose message content, route endpoints, credentials, sockets, session IDs, Request IDs, raw protocol errors, or binding material. Diagnostics may show safe route class, binding generation, timing, and retry count, but never endpoint, credential, raw transport, or message content. Errors name the Crew Principal and provide one safe corrected setup/send command when one can be generated without guessing.

## Delivery and terminal states

Persistence, handoff, acknowledgement, Response, and task completion are separate:

- **Persisted** means the bounded Principal outbox atomically stored the message.
- **Pending** means a persisted message is waiting for a valid bound route or delivery attempt.
- **Handed to Principal** means the approved route acknowledged receipt by its protocol. It does not mean read or acted on.
- **Rejected** means policy, identity, authorization, schema, or version validation prevented persistence.
- **Expired** means retention ended before handoff; content is removed according to the bounded retention policy and no delivery is claimed.
- **Revoked** means the binding or Principal policy was explicitly disabled; no new delivery is attempted.
- **Unknown** means the delivery boundary could not establish whether receipt occurred. Retry is not automatically safe unless the same stable message identity is used.
- **Cancelled** means an unsent message was removed before persistence or handoff. A cancellation after persistence is best effort and must not claim withdrawal from an external route.

The route adapter must be idempotent by stable message identity. A retry of the same Principal message may produce one additional delivery attempt, never a new logical message. Completion evidence is durable and idempotent; duplicate acknowledgements do not change the terminal state or create another message.

## State table

| Condition | State/result | Safe behavior |
| --- | --- | --- |
| No `principalContact` block | `disabled` / rejected | fail before content persistence; show explicit setup command; never fall back |
| Member not in `allowedSenders` | `unauthorized` / rejected | reject before persistence; do not infer authority from role, lead, or Guest status |
| Principal identity does not match the configured Crew policy | `mismatch` / rejected | reject before routing; no cross-Crew delivery or content disclosure |
| Route has never been bound | `unbound` / rejected | request explicit binding; do not queue content against an unknown destination |
| Binding revoked | `revoked` / rejected for new sends | retain no new content; existing pending items require explicit policy after rebind |
| Binding is stale or generation mismatches | `stale-route` / pending or rejected | stop delivery; require explicit rebind; never probe an old route or guess a replacement |
| Principal is offline after a valid binding | `persisted` then `pending` | keep bounded FIFO outbox; do not claim handoff; expire deterministically |
| Current Member is authorized and route is valid | `persisted` → `handed` | enqueue atomically, deliver FIFO, and report only the observed state |
| Concurrent authorized sends | ordered `persisted` | serialize by one monotonic outbox sequence; preserve each message identity and FIFO order |
| Retry or replay of one message | same message identity | deduplicate logical enqueue and adapter completion; never create a second logical message |
| Route rotation with matching Principal identity | `pending` until rebind, then eligible | require explicit binding operation; preserve sequence and retry only with stable identity |
| Duplicate completion evidence | unchanged terminal state | accept idempotently; never report two handoffs or alter freshness |
| Retention deadline reached | `expired` | remove atomically, record bounded terminal evidence, and never claim delivery |
| Cancellation before persistence | `cancelled` | remove local pending work atomically; no route call |
| Cancellation after persistence or unknown delivery | `unknown` or `cancelled` only if evidence proves no handoff | never promise remote withdrawal; provide a safe retry/reconciliation command |
| Crew member lacks current membership | `unauthorized` / rejected | fail closed before reading or storing message content |
| Destination reports another Principal or Crew | `mismatch` / rejected | stop immediately; record no route detail in default output; prevent cross-Crew leakage |
| Adapter protocol/version mismatch | `rejected` or `unknown` | fail closed with a safe upgrade/rebind command; never downgrade silently |

## Safe setup and recovery commands

The future CLI uses product identities and local files, never transport identifiers. Each failure should print one corrected command without embedding message content or route material:

```text
pi-bebop crew principal configure --identity <principal-id> --allow-sender <member-name>
pi-bebop crew principal bind --identity <principal-id>
pi-bebop crew principal send --identity <principal-id> --message-file ./update.md
pi-bebop crew principal status --identity <principal-id>
pi-bebop crew principal bind --identity <principal-id> --rebind
```

Missing configuration points to `configure`; an unbound or stale destination points to `bind`; an offline Principal points to `status` and a safe retry of the same message file; invalid size/retention policy points to `configure` with bounded values; and a protocol/version mismatch points to `bind --rebind`. These are proposed product commands, not an implementation commitment. The command must never substitute a guessed identity, inline secret, socket, session alias, or message body.

## Security and failure rules

- Binding creation, rotation, and revocation must check trusted project/Crew state before manifest or route mutation. Canonicalize local paths and reject traversal and symlink escape where local storage is involved.
- The adapter validates Crew Selector and Principal identity together. A route bound for one Crew cannot be reused by another Crew, even when display names match.
- A Principal route is outbound-only. Possessing route material grants no membership, Guest capability, inbound send right, Request/Response right, role, instructions, Broadcast right, approval right, or access to Crew Status.
- Core routing uses a Pi Bebop application/infra seam and protocol. It must not shell out to `pi`, require pi-intray, or expose `--control-session`, `--send-session-message`, session IDs, or sockets as the product API.
- Unknown delivery after timeout or cancellation is not silently retried with a new identity. Reconciliation uses the original stable message identity and reports uncertainty honestly.
- No message content is written before authorization, identity, binding, version, size, and retention validation succeeds. Storage uses atomic writes, bounded capacity, deterministic FIFO ordering, and evidence-gated removal.

## Review checklist

Before implementation tasks start, every reviewer should be able to answer yes:

- [ ] Product: Principal contact is clearly one-way and does not expand Crew membership or authority.
- [ ] Security: binding, rotation, revocation, cross-Crew checks, replay handling, and privacy redaction fail closed.
- [ ] Development: the application/infra seam is independent of pi-intray and has deterministic state transitions and idempotent evidence.
- [ ] QA: each state-table row has a testable happy or unhappy path without live external transport.
- [ ] Operations: setup, rebind, expiry, unknown delivery, and version mismatch each have one safe corrected command.

## Non-goals

Making a Principal a Crew participant, two-way chat, Request/Response, Guest membership, remote-network identity, task tracking, progress inference, or preserving the raw pi-intray workaround as a product API.
