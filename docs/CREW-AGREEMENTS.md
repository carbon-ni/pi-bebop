# Crew Agreements and Retrospectives

Status: **defined, not implemented**.

Use the [STE100 profile](STYLE.md) when you edit this reference. Keep record states, schemas, and fixed values exact.

## Problem

A Crew can find better ways to collaborate. Bebop needs one clear way to retain, review, and apply those agreements.

A Role, claimed Origin, Member message, or model summary must not change shared instructions. Restart must not change a retrospective result.

## Desired outcome

A Crew can maintain one versioned set of **Current Crew Agreements** and review
its shared work through bounded **Crew Retrospectives**. Bebop detects when a
retrospective is due, an exact configured Member coordinates it, every Member
reviews the same evidence-backed record, and only an explicit trusted project
operation activates a candidate Agreement revision.

The contract keeps four things separate:

```text
Retrospective evidence
  -> candidate interpretation
  -> Agreement proposal / candidate Agreement revision
  -> explicit Agreement activation
```

No earlier stage implies or performs a later stage.

## Product boundaries

- A **Crew Agreement** is shared collaboration instruction, not project
  guidance, Role instructions, Message instructions, task state, or permission.
- Visible work produced in Crew scope is Crew-readable by default. Credentials
  and secrets are redacted; hidden model reasoning is unavailable. Security
  redaction is not a Member privacy boundary.
- Evidence records what a source exposed. It does not prove an interpretation,
  quality, completion, intent, or authority.
- Role is descriptive routing metadata. Origin is claimed attribution. Neither
  can start a retrospective for another Member, activate an Agreement revision,
  or authorize a project mutation.
- A Retrospective facilitator coordinates one round. Facilitator status does not
  grant Agreement activation authority.
- Agreement activation is not a Member tool or message outcome in v1. It is an
  explicit operator-controlled project operation against the exact canonical,
  trusted Crew layout. Filesystem access is caller consent; it is not proof of a
  human identity.
- **Accepted** retains its delivery meaning. Agreement revisions are
  `candidate`, `activated`, or `superseded`—never Accepted.

## Conceptual configuration

The exact manifest/version migration belongs to implementation tasks. The
product contract requires configuration equivalent to:

```json
{
	"crewAgreements": {
		"file": "agreements/current.md",
		"retrospective": {
			"cadenceDays": 14,
			"facilitator": "Mary"
		}
	}
}
```

Rules:

- `file` selects one project-local Current Crew Agreements source beneath the
  canonical Crew layout.
- `facilitator` is one exact configured Member name. A Role is never resolved as
  facilitator and there is no online/first-member fallback.
- cadence is optional. Without it, Crew Retrospectives are manual-only.
- cadence is a bounded positive count of 24-hour durations, evaluated against
  injected UTC instants—not calendar locale, local timezone, process uptime, or a
  background timer.
- a Crew may have Current Crew Agreements without enabling Retrospectives.

## Authority and triggers

| Event                        | Trigger owner                                                | Effect                                                       | Explicitly does not do                                    |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| Retrospective becomes due    | Bebop with injected clock                                    | Persists one reminder for exact facilitator                  | Start a round, contact other Members, activate Agreements |
| Retrospective starts         | Current Member matching exact facilitator                    | Opens one round and fixes its interval/base snapshots        | Grant permission or activate Agreements                   |
| Facilitator takeover         | Trusted project operator naming exact Member                 | Replaces coordinator for one round with recorded provenance  | Infer from Role, Presence, Activity, or roster order      |
| Member review                | Each configured Member through one correlated Member request | Confirms, corrects, or disputes record and proposes changes  | Imply consensus through silence/timeout                   |
| Candidate revision produced  | Retrospective facilitator                                    | Persists immutable candidate based on exact current revision | Make it current                                           |
| Agreement revision activates | Trusted project operator                                     | Atomically changes Current Crew Agreements                   | Hot-reload active Memberships or impersonate a Member     |
| Activation notice enqueues   | Bebop after durable activation                               | Persists one bounded Inbox item for every configured Member  | Perform activation or become Crew Broadcast               |

Any Current member may submit an Agreement proposal when that capability exists.
A proposal records the Member's attribution and evidence references; it grants
no activation authority. External input becomes a proposal only when a Current
member deliberately creates one—it is never upgraded automatically by Crew
Intake.

## Retrospective scheduling

### Durable cadence anchor

For a Crew with cadence, the anchor is:

1. the latest completed Retrospective's persisted `completedAt`; otherwise
2. one persisted `configuredAt` instant created exactly once when valid
   Retrospective configuration is first observed through the trusted project
   boundary.

The due instant is `anchor + cadence`. The interval is arithmetic over UTC
instants. Same durable state and same injected clock value produce the same
result.

### Due detection

Bebop derives cadence only after the trusted layout/configuration is validated,
at these finite boundaries: successful Membership join/restore/rejoin, the exact
facilitator's `agent_settled`, an explicit Retrospective status/start operation,
and Retrospective completion. It does not arm a timer or poll while every
Member is inactive. At each boundary it derives:

- **not due** — no round is open, no due marker exists for the current anchor,
  and `now < dueAt`;
- **due** — no round is open and either a persisted due marker exists for the
  current anchor or `now >= dueAt`; the first crossing persists the marker
  before its reminder side effect;
- **open** — one round exists, regardless of later clock movement;
- **completed** — terminal state of a specific round, retained as history; the
  Crew's next schedule anchors to its `completedAt`.

Due detection:

- enqueues at most one non-interrupting durable reminder for the exact
  facilitator and cadence anchor;
- never starts a round, sends Member requests, polls Presence/Activity, or
  interrupts a Member;
- does not create one round per missed cadence when the clock jumps forward;
  one due state remains until one round starts/completes;
- does not rewrite the anchor when the clock moves backward. Before the due
  transition, `now < anchor` reports a clock-before-anchor diagnostic and
  remains not due. After the transition, the persisted due marker wins over
  wall-clock regression and remains due until its round opens/completes;
- is idempotent across repeated hooks, concurrent sessions, and restart.

An offline facilitator receives the reminder later through Inbox. A missing or
removed configured facilitator is an explicit invalid/unavailable state; Bebop
never falls back to a Role, Crew contact, lead, first Member, or online Member.

## Starting and recovering a round

The exact configured facilitator may start a due round or deliberately start a
manual round before it is due. Start persists before external coordination:

- stable Retrospective ID;
- exact facilitator;
- `startedAt` from injected clock;
- half-open evidence interval `[anchor, startedAt)`;
- manifest-order Member roster snapshot;
- exact Current Crew Agreements revision;
- bounded pending Agreement proposal IDs;
- collector versions and deterministic collection limits.

The start operation is idempotent. Repeating the same start returns the existing
open round unchanged. Starting while another round is open reports the existing
round and performs no second collection or Member request.

An unavailable facilitator never causes automatic reassignment. A trusted
project operator may perform an explicit takeover by naming an exact configured
Member. Before start, takeover binds to the exact persisted due marker/cadence
anchor; after start, it binds to the exact open Retrospective ID. Takeover
records prior/new facilitator and reason, does not edit the manifest, does not
grant activation authority, and reuses existing collection/request identities
so restart or takeover cannot duplicate Member requests.

Open round state is durable and survives process/session restart. Restore
continues the persisted phase; it never creates a new round from cadence.

## Open-round phases

`open` has deterministic internal phases:

1. **collecting** — gather bounded evidence for the fixed interval and one
   Member retrospective report per roster Member;
2. **record frozen** — persist one immutable Crew Retrospective Record and its
   content hash;
3. **reviewing** — every roster Member receives the same record identity and a
   bounded review deadline;
4. **ready to complete** — review deadline/explicit closure has classified every
   expected Response as received, missing, offline, timeout, malformed, or late.

A phase transition persists before messages or other retryable side effects.
Every retry uses stable Retrospective/Member/phase identity.

## Evidence and the shared record

### Evidence sources

The fixed interval collects from three source families:

1. **Bebop coordination** — Member request/Response outcomes, delivery
   dispositions/failures, Inbox/Crew Broadcast outcomes, Interrupt lifecycle,
   and relevant Membership/control failures;
2. **repository work** — reachable commits, `plans/` lifecycle changes,
   retained reports, and retained watcher/verification evidence;
3. **Member retrospective reports** — each exact Member's bounded report from
   visible Crew-session messages, tool calls/results, decisions, friction,
   rework, and helpful situations.

Optional explicit Member observations may supplement these sources. Missing,
corrupt, unavailable, or truncated sources remain explicit. Absence of retained
evidence is not interpreted as absence of work.

### Interval and late evidence

Events belong to the interval by their validated source instant, not collection
time. Member reports are created during collection but describe the fixed
interval.

- Events at `anchor` are included.
- Events at or after `startedAt` belong to the next interval.
- Collector results arriving before record freeze may enter the current record.
- Evidence discovered after record freeze cannot mutate the record or current
  candidate revision and is retained with provenance for the next
  Retrospective. During review, a Member may append an attributed
  correction/dispute annotation against existing evidence, but newly supplied
  supporting evidence still carries forward.

### Crew Retrospective Record

The record contains:

- fixed interval, roster, base Agreement revision, collector versions, limits,
  and explicit missing/truncated-source states;
- deterministic evidence index with stable IDs, provenance, redaction markers,
  and drill-down references;
- bounded Retrospective situations, each with evidence IDs, contributors,
  factual summary, separately labelled candidate interpretation, and related
  Current/Trial Agreement IDs when present;
- preserved conflicting accounts rather than silent synthesized consensus.

No Retrospective situation exists without an evidence reference. A
model/facilitator may synthesize candidate situations, but producer and exact
synthesis bytes are retained; nondeterministic model output is never presented
as deterministic domain inference.

The record is immutable once frozen. All configured Members receive/inspect the
same exact record ID, content hash, and bytes. Deterministic overflow reports
omitted counts and retains references; Crew transparency does not require an
unbounded transcript dump.

## Member review

Every roster Member receives one correlated Member request containing the same
record identity and questions covering:

- evidence correction or missing context;
- agreement/disagreement with each candidate interpretation;
- Start/Stop/Continue;
- Current and Trial Agreement review;
- Agreement add/amend/remove proposal;
- explicit objections.

Response preserves existing Member request semantics. Accepted never means
answered, and idle/timeout/offline never means agreement. Each Response outcome
is recorded explicitly.

A correction appends attributed review evidence; it never rewrites the frozen
record. An objection remains visible in the completed Retrospective and any
candidate revision. V1 does not require unanimous consensus and does not infer
consent from silence. The trusted operator decides whether to activate a
candidate after seeing objections and missing Responses.

The reviewing phase has one persisted deadline. A Response received after that
deadline is labelled late; only its late outcome marker attaches to the current
round. Its content is retained with provenance for the next Retrospective and
cannot alter the frozen record, current interpretation decisions, or candidate
revision—even when it arrives before current-round completion.

## Completion and candidate revision

The facilitator completes a round with exactly one of:

- **no change** — Current Crew Agreements remain unchanged;
- **candidate revision** — immutable add/amend/remove operations based on the
  exact Current Crew Agreements revision captured at start.

Completion persists:

- `completedAt` from injected clock;
- every expected Member Response outcome;
- corrections, disputes, objections, and missing-source states;
- no-change reason or candidate revision ID;
- one explicit result for every reviewed Trial Agreement: `retain-trial`,
  `graduate`, `amend`, or `remove`.

Trial Agreements never expire automatically. Until an Agreement revision
containing `graduate`, `amend`, or `remove` is activated, the prior Trial
Agreement remains Current and must appear again at the next Crew Retrospective.

Completion is terminal and idempotent. Restart cannot reopen or duplicate it.
A clock value before `startedAt` cannot produce completion; it reports a
clock-before-start diagnostic without mutating state. A forward jump may pass a
review deadline but cannot automatically complete the round—the facilitator
still performs explicit completion.

## Agreement revision and activation

A candidate Agreement revision is immutable and identifies:

- exact base Current Crew Agreements revision;
- deterministic add/amend/remove operations;
- source Retrospective/proposal/evidence references;
- Trial Agreement state;
- objections and missing Member Responses;
- candidate content hash.

A candidate revision is not active instruction. Before any write, Agreement
activation validates the canonical trusted layout, candidate integrity, and
that its base revision is still current. A stale base, changed candidate,
invalid path/content, or concurrent activation fails atomically with no change
to Current Crew Agreements.

Activation atomically publishes the candidate as Current Crew Agreements and
records prior/current revision provenance. Exact rerun when that same revision
is already current is an unchanged success. Attempting to activate it after a
different revision became current is a stale/conflict failure.

Active Memberships retain their existing instruction snapshot. The newly
activated revision loads only on next Membership join/restore/rejoin; no
mid-turn or hot instruction mutation occurs.

## Agreement activation notice

After durable activation, Bebop enqueues one bounded Agreement activation notice
through each configured Member's Inbox. It contains revision identity, prior
revision, bounded change summary, and guidance that the revision applies at the
next Membership snapshot.

The notice:

- is system-produced, so it is not Crew Broadcast (which requires a Current
  member initiator);
- is informational and not the source or trigger of Agreement activation;
- never includes raw evidence, credentials, or unbounded proposal content;
- reaches offline Members through normal Inbox handoff;
- may partially fail after activation. Such failure never rolls back Current
  Crew Agreements and is reported honestly per Member. Retry uses stable
  revision/Member identity and never duplicates activation.

## Restart and failure semantics

| Situation                                   | Required result                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Repeated due checks                         | One persisted due marker and at most one facilitator reminder per anchor                                   |
| Clock moves backward                        | Before crossing, report diagnostic; after crossing, persisted due marker wins; never duplicate or skip due |
| Clock jumps across several cadences         | One due state, never catch-up rounds                                                                       |
| Duplicate start                             | Return same open Retrospective; no duplicate collectors/requests                                           |
| Facilitator unavailable                     | Remain due/open; no fallback; takeover names exact Member and binds due marker/open round                  |
| Restart while collecting/reviewing          | Resume persisted phase with stable IDs and deadlines                                                       |
| Collector missing/fails                     | Record explicit source gap; do not fabricate completeness                                                  |
| Member offline/times out                    | Preserve exact Request outcome; never infer agreement                                                      |
| Late Response/evidence                      | Record late marker only; content/evidence carries to next round and cannot affect current candidate        |
| Member disputes interpretation              | Preserve evidence plus dispute; never silently create consensus                                            |
| Current Agreement changes during open round | Candidate keeps captured base; activation later fails stale unless intentionally rebuilt                   |
| Duplicate completion/activation             | Same semantic operation is unchanged success                                                               |
| Activation notice enqueue fails             | Activation stays durable; report/retry failed Member notices only                                          |

## Explicitly deferred

V1 does not include:

- automatic Retrospective start or completion;
- automatic facilitator selection/takeover;
- Role-based or Member-message activation authority;
- Crew voting, unanimous-consensus enforcement, or automatic activation;
- hot reload of active Member instruction snapshots;
- semantic truth/conflict resolution or model-judged Crew health;
- sentiment, productivity, availability, or performance scoring;
- unbounded transcript/artifact embedding;
- external template/Agreement registry, ratings, signing, or automatic upstream
  Agreement updates;
- calendar providers, cron daemon, background polling, or one catch-up round per
  missed cadence.

## Planned implementation slices

- TASK-0095 — common shared instruction composition plumbing;
- TASK-0104 — load Current Crew Agreements for every Member;
- TASK-0105 — persist Agreement proposals and revisions;
- TASK-0106 — trusted Agreement activation and activation notices;
- TASK-0111 — bounded Retrospective evidence contract/storage;
- TASK-0112/0113/0114 — Bebop, repository, and Member-report evidence sources;
- TASK-0115 — shared Crew Retrospective Record;
- TASK-0107 — manual Crew Retrospective orchestration;
- TASK-0108 — deterministic cadence reminders;
- TASK-0109 — initial Agreements through Crew templates;
- TASK-0110 — executable lifecycle verification and documentation gate.
