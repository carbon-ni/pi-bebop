---
id: TASK-0152
title: Show message origin and age at delivery
status: todo
depends_on: []
priority: normal
tags: [messaging, provenance, timing, staleness, ux, deterministic]
---

# Show message origin and age at delivery

## Problem

A Member can consume a Bebop message long after it was sent, especially after
Inbox persistence, restart, compaction, or other delayed handoff. Current
structured messages carry Origin, but it is buried in payload context and no
consistent model-visible age explains how old the message was when delivered.
The receiving agent can therefore treat hours-old instructions as current
without enough evidence to judge relevance.

Bebop must provide provenance and timing evidence without deciding whether a
message is stale. Relevance depends on message content and current work; a fixed
age threshold would silently discard valid communication.

## Desired outcome

Every Bebop message that enters model context starts with one compact
provenance-and-timing header. Ordinary deliveries show frozen Age at delivery:

```text
[follow-up] from Mony (lead) · age at delivery 2h 14m
```

```text
[member request] from Dave (dev) · age at delivery 37m · request request_123
```

External Origin remains visibly unverified:

```text
[external intake] from jira-automation (unverified) · age at delivery 1d 3h
```

A correlated Response instead shows Request age because that exposes how old
the request context is; Response delivery age would usually be near zero and
would hide the risk demonstrated by a late response:

```text
[member response] from Dave (dev) · request age 1d 3h · request request_123
```

The header gives the receiving agent enough evidence to accept, re-check, or
ignore old content. Bebop never labels a message stale, drops it automatically,
changes delivery order, or infers that its work is still relevant.

## Ubiquitous language

- **Sent time** — source-owned instant when transient delivery starts or durable
  message is enqueued. It is delivery metadata, not caller-supplied content.
- **Delivered time** — recipient-owned instant when Bebop hands the message to
  Pi for model-visible delivery. It is not socket acknowledgement or proof the
  model understood the content.
- **Age at delivery** — nonnegative elapsed time from Sent time to Delivered
  time, frozen when delivered. It does not increase when history is replayed.
- **Request age** — nonnegative elapsed time from accepted Member Request to
  correlated Response receipt, frozen when outcome is returned. It describes
  request-context age, not Response transit time or completion.
- **Stale** — a contextual judgment made by receiving agent or user. Bebop
  provides age evidence but never computes a stale/not-stale classification.

Add these terms and relationships to `UL.md` before implementation naming is
spread across protocol, storage, and renderers.

## Approved contract

### Header

- Model-visible header includes canonical semantic message kind, Origin, and
  timing evidence before message content.
- Canonical kinds are exactly `follow-up`, `member request`, `redirect`,
  `interrupt`, `inbox`, `broadcast`, `external intake`, and `member response`.
  Kind describes source intent; durable storage does not silently turn a
  Broadcast or external Intake into an Inbox message.
- All kinds except `member response` show `age at delivery`; `member response`
  shows `request age` because that is the relevant stale-context evidence.
- Crew Origin renders `from <name> (<role>)`.
- External Origin renders `from <label> (unverified)` because attribution is
  never authentication.
- Missing historical Origin renders `from unknown`; it is never guessed from
  socket path, session, alias, filename, content, or role instructions.
- Member Request header also keeps opaque Request ID and responder affordance.
- TUI label uses the same typed metadata and compact age. Callback `replyTo`,
  socket, session ID, alias, manifest path, timer handle, and storage route stay
  hidden.

### Timing ownership

- Public send tools and CLI commands do not accept caller-provided timestamps.
- Composition/application boundary captures Sent time from an injected Clock.
- Transient Follow-up, Redirect, Interrupt, and Member Request carry bounded
  Sent time through validated transport.
- Durable Inbox, Broadcast, and external Intake use persisted `enqueuedAt` as
  Sent time across restart; do not reset age when offering or retrying delivery.
- Recipient captures Delivered time from injected Clock at Bebop-to-Pi model
  handoff, not at socket acknowledgement.
- Correlated Response captures Request age from accepted Request to Response
  receipt using existing Request lifecycle time. It does not substitute the
  usually-near-zero Response delivery age; wording remains Response received,
  never task completed.
- Timestamp metadata is finite nonnegative integer epoch milliseconds within
  safe numeric bounds. Invalid, missing, future, or overflowed timing produces
  `age at delivery unavailable`; never clamp to a misleading zero or emit a
  negative duration.

### Deterministic formatting

Age at delivery and Request age use one pure formatter from a frozen elapsed
millisecond value:

- below 1 second: `<1s`;
- below 1 minute: whole seconds;
- below 1 hour: whole minutes;
- below 1 day: whole hours plus remaining whole minutes;
- one day or more: whole days plus remaining whole hours.

Formatting truncates smaller units, has explicit boundary tests, is locale- and
timezone-independent, and never calls current time internally.

### Surfaces

Apply the same provenance-and-timing envelope to all model-bound Bebop
communication, using these exact kind labels:

- `[follow-up]` for Follow-up;
- `[member request]` for Member Request;
- `[redirect]` for Redirect;
- `[interrupt]` for Interrupt recovery;
- `[inbox]` for a direct durable Inbox handoff;
- `[broadcast]` for Crew Broadcast, including durable handoff;
- `[external intake]` for external Crew Intake, including durable handoff;
- `[member response]` for correlated Response returned by
  `wait_for_request_outcome`.

Presence, Member Status, roster, control notifications, CLI help, and internal
protocol diagnostics are not messages and do not receive this header.

### Relevance boundary

- Header gives evidence only. No age threshold, warning severity, expiry,
  rejection, reordering, retry, Redirect, cancellation, or automatic response
  is introduced.
- Tool and workflow guidance says receiving agent may compare old content with
  current state before acting.
- Age does not prove message was read, acknowledged, correct, urgent, obsolete,
  or safe to ignore.

## Acceptance criteria

- [ ] TDD first characterizes current Origin rendering and missing timing on
      happy paths, then adds new contract.
- [ ] `UL.md` defines Sent time, Delivered time, Age at delivery, Request age,
      and Stale with explicit attribution/authentication and relevance
      boundaries.
- [ ] One pure formatter covers every duration bucket and exact boundary,
      invalid value, overflow, future timestamp, and clock-skew path using fake
      clocks only.
- [ ] Crew, external, and unknown Origin headers render exact approved wording;
      external Origin always includes `(unverified)`.
- [ ] Member Request header preserves Request ID and responder instruction while
      adding Origin and age without duplicate headers.
- [ ] Transient real-wire tests prove source Sent time survives validated RPC
      and recipient Delivered time determines frozen age at Pi handoff.
- [ ] Busy/rejected transient delivery creates no misleading delivered age or
      target model message.
- [ ] Durable Inbox restart test proves original persisted `enqueuedAt` survives
      reload/retry and a hours-old item exposes the corresponding age rather
      than offer time.
- [ ] Broadcast and external Intake reuse durable timing semantics without
      generating one new Sent time per recipient or retry.
- [ ] Correlated Response direct tool result uses the exact `[member response]`
      header with configured Member Origin, deterministic `request age`, and
      opaque Request ID while preserving full message and ordered instructions;
      it does not report misleading Response `age at delivery`.
- [ ] TUI collapsed/expanded renderers and model-visible content use typed
      metadata consistently; replay does not increase frozen age.
- [ ] Missing/legacy timing remains deliverable and visibly says age unavailable;
      schema migration never invents time.
- [ ] Malformed or caller-injected timestamp is rejected before delivery and
      cannot alter Origin, ordering, persistence, or another message.
- [ ] Repository search proves no socket/session/callback/storage route appears
      in header and no automatic stale classification exists.
- [ ] Real multi-runtime regression covers an immediate message and a delayed
      durable message with exact deterministic headers.
- [ ] Focused unit/integration/storage/package coverage, architecture checks,
      full gate, fresh unchanged watcher fingerprint, and independent exact-head
      QA pass.

## Constraints

- Use injected Clocks and fake time; no wall-clock sleeps or locale formatting.
- Keep business timing/formatting pure in Domain, persistence in Infra,
  delivery composition in Pi/Application, and dependency wiring in
  `src/extension.ts`.
- Preserve strict `MessagePayload`/RPC validation, payload byte limits, FIFO,
  exactly-once handoff evidence, and historical message compatibility.
- Origin remains attribution. Timing remains evidence. Neither is an
  authentication, acknowledgement, relevance, or completion claim.

## Non-goals

- Automatically ignoring, expiring, deleting, reordering, prioritizing, or
  warning on old messages.
- User-configurable stale thresholds, TTL, escalation, retry, reassignment, or
  task-state inference.
- Clock synchronization across machines or trusting external timestamps.
- Rewriting historical session entries or backfilling unknown transient times.
- Showing live continuously increasing age in replayed TUI history.

## Verification

- Product review of header wording, timing instants, surfaces, invalid-time
  behavior, and relevance boundary before implementation.
- Fake-clock unit tests, real transient/durable delivery integrations, package
  inventory, and fresh exact-head final gate before closure.
