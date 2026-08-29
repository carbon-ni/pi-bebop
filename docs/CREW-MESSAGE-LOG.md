# Crew Message Log

Use the [STE100 profile](STYLE.md) when you edit this reference. Keep event names, schemas, and fixed values exact.

Status: **defined, not implemented**.

## Problem

Bebop stores messaging outcomes in several places. These places include live delivery, Inbox state, and feature records. The crew needs one retained account of the observed outcomes and capture gaps.

The log must stay bounded and crew-readable. It must state gaps. It must not become a delivery queue, surveillance feed, or source of inferred Member qualities.

## Desired outcome

The **Crew Message Log** is one project-local, append-only evidence source for
Bebop-owned Crew messaging lifecycle facts. A **Log Entry** records one
allow-listed mechanical event with bounded, deterministically redacted visible
payload representation when that event owns a payload. A **Messaging Review**
combines a fixed Log interval with directly attributed Member feedback; Log
activity alone never proves what Members prefer.

```text
Bebop messaging operation reaches a mechanical transition
  -> canonical Log Entry append is attempted after the transition
  -> delivery outcome remains unchanged if evidence capture fails
  -> every Current Member may explicitly pull retained active-layout history
  -> later Messaging Review separates evidence, feedback, interpretation, proposal
```

## Product boundaries

- The Log is evidence, not delivery. It cannot send, redirect, enqueue, hand
  off, interrupt, respond, acknowledge, mark read, retry, or complete work.
- Capture is internal to allow-listed shared application seams. There is no
  caller-authored Log Entry tool, command, protocol command, or public append
  API.
- Every Current Member has identical pull access to every retained entry in the
  active Crew layout, including entries captured before that Member joined or
  rejoined. Role never changes visibility.
- Membership-derived source/target identity is application attribution.
  `Origin` remains claimed/unverified wire attribution and is stored separately.
  Neither grants authority.
- Visible message content and Message instructions may be retained only through
  the exact bounded representation below. Role instructions, system prompts,
  provider input/output not already visible as a Crew message, hidden reasoning,
  callback routes, socket paths, session IDs/aliases, stacks, and raw dependency
  errors are never Log fields.
- Capture gaps are evidence. Missing entries, an unavailable endpoint, a crash,
  pruning, or an append failure never becomes a claim that no messaging
  occurred.
- No Log Entry or aggregate may rank Members or infer availability,
  productivity, quality, intent, sentiment, preference, agreement, consensus,
  completion, or fault.
- Application Membership is not an operating-system confidentiality boundary.
  A process with project-filesystem access may inspect runtime files outside
  Bebop.

## V1 surface inventory

V1 includes only operations routed through trusted Crew application seams.
Nested Inbox persistence/handoff keeps the initiating logical surface so the
same transition is not duplicated under both `member-inbox` and its parent.

| Surface           | Included logical operation                                                                        | Payload-owning event     |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| `follow-up`       | Current Member normal live message to one exact Member                                            | `delivery`               |
| `redirect`        | Current Member insertion into one exact Member's active work                                      | `delivery`               |
| `member-request`  | Current Member request requiring one correlated Response                                          | `delivery`               |
| `member-response` | Authenticated Response to one Member request                                                      | `delivery`               |
| `member-inbox`    | Direct Member Inbox enqueue and system-produced Inbox items not owned by another included surface | `persistence`            |
| `crew-broadcast`  | Current Member durable fan-out, per-recipient persistence/handoff, and one aggregate summary      | `broadcast-summary` only |
| `interrupt`       | Pending recovery persistence, best-effort abort, and recovery handoff                             | `recovery`               |
| `crew-intake`     | External/unverified input persisted for the exact configured Crew contact                         | `persistence`            |

The following are excluded in v1:

- generic `send_to_session`, startup CLI session sends, non-Crew Pi messages,
  and traffic addressed by global session ID/name/socket rather than Membership;
- Presence, Activity, Member Status, Member/Crew Idle Wait, discovery probes,
  aliases, and control-protocol housekeeping;
- Crew Board reads/Posts, Agreement content, Retrospective records/reviews,
  repository evidence, prompts, model turns, and tool calls/results that are not
  themselves an included Crew message;
- OS/socket packets and Pi-owned queue internals.

An included operation stays included regardless of whether its public adapter
is a tool, slash command, startup Intake path, or internal handoff hook. Capture
occurs once at the shared application transition, not once per adapter.

## Closed lifecycle vocabulary

### Stages

A message event has exactly one stage:

`delivery | persistence | handoff | request-terminal | broadcast-summary | recovery | abort`

### Outcomes

A message event has exactly one outcome:

`direct | queued | redirected | offline | persisted | already-persisted | offered | handoff-recorded | response-recorded | timeout-max-wait | timeout-response-after-idle | cancelled | pending | already-pending | abort-requested | no-active-context | complete | partial | no-recipients | failed`

The only valid surface/stage/outcome combinations are:

| Surface           | Stage               | Allowed outcomes                                                                                         |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `follow-up`       | `delivery`          | `direct`, `queued`, `offline`, `failed`                                                                  |
| `redirect`        | `delivery`          | `redirected`, `offline`, `failed`                                                                        |
| `member-request`  | `delivery`          | `direct`, `queued`, `offline`, `failed`                                                                  |
| `member-request`  | `request-terminal`  | `response-recorded`, `offline`, `timeout-max-wait`, `timeout-response-after-idle`, `cancelled`, `failed` |
| `member-response` | `delivery`          | `direct`, `queued`, `offline`, `failed`                                                                  |
| `member-inbox`    | `persistence`       | `persisted`, `already-persisted`, `failed`                                                               |
| `member-inbox`    | `handoff`           | `offered`, `handoff-recorded`, `cancelled`, `failed`                                                     |
| `crew-broadcast`  | `persistence`       | `persisted`, `already-persisted`, `failed`                                                               |
| `crew-broadcast`  | `handoff`           | `offered`, `handoff-recorded`, `cancelled`, `failed`                                                     |
| `crew-broadcast`  | `broadcast-summary` | `complete`, `partial`, `no-recipients`, `failed`                                                         |
| `interrupt`       | `recovery`          | `pending`, `already-pending`, `direct`, `handoff-recorded`, `failed`                                     |
| `interrupt`       | `abort`             | `abort-requested`, `no-active-context`, `failed`                                                         |
| `crew-intake`     | `persistence`       | `persisted`, `already-persisted`, `failed`                                                               |
| `crew-intake`     | `handoff`           | `offered`, `handoff-recorded`, `cancelled`, `failed`                                                     |

`Accepted`, `Persisted`, Handoff, Response, timeout, offline, and completion
remain distinct. `failed` states only that the named stage failed. It carries a
closed safe error code when known and `unexpected-failure` otherwise; it never
copies or classifies arbitrary exception text. Retryability is not inferred.

A Broadcast has one per-recipient persistence event and one per-recipient
handoff lifecycle, all on `crew-broadcast`. Its aggregate summary is `complete`
only when every frozen recipient persistence outcome succeeded or replayed,
`partial` when outcomes differ, `no-recipients` for the canonical empty fan-out,
and `failed` only when no honest recipient result set can be produced. Summary
counts never replace recipient evidence.

## Message Event contract

### Canonical v1 shape

```json
{
	"version": 1,
	"kind": "message-event",
	"id": "entry-<64 lowercase hex>",
	"occurredAt": "2026-08-28T12:34:56.789Z",
	"surface": "follow-up",
	"stage": "delivery",
	"outcome": "queued",
	"operation": {
		"id": "op-<64 lowercase hex>",
		"lifecycleSequence": 1
	},
	"actorKind": "member",
	"sourceMember": { "name": "Mary", "role": "po" },
	"targetMember": { "name": "Dave", "role": "dev" },
	"claimedOrigin": {
		"state": "captured",
		"value": { "kind": "crew", "name": "Mary", "role": "po" },
		"redactions": []
	},
	"deliveryIntent": "follow-up",
	"correlations": [{ "kind": "request", "id": "ref-<64 lowercase hex>" }],
	"payload": {
		"state": "represented",
		"reason": null,
		"content": {
			"state": "captured",
			"reason": null,
			"text": "Please inspect the failure.",
			"normalizedUtf8Bytes": 27,
			"retainedUtf8Bytes": 27,
			"omittedUtf8Bytes": 0,
			"truncated": false,
			"escapedMarkerCount": 0,
			"redactions": []
		},
		"instructions": [],
		"instructionCount": 0
	},
	"errorCode": null,
	"summary": null,
	"capture": {
		"endpointId": "endpoint-<64 lowercase hex>",
		"epochId": "epoch-<64 lowercase hex>",
		"attemptSequence": 42,
		"capturedAt": "2026-08-28T12:34:56.800Z"
	},
	"semanticFingerprint": "<64 lowercase hex>"
}
```

Every field is present; nullable fields use `null` rather than omission.
Unknown fields, versions, enum values, and invalid surface/stage/outcome tuples
fail closed.

### Identity and attribution

- `occurredAt` is the exact source transition's injected UTC instant in
  canonical millisecond ISO-8601 form. It is not file mtime, append time, or
  observer wall-clock inference.
- `actorKind` is `member`, `external`, or `system`. `sourceMember` is required
  exactly for `member` and null otherwise. `external` is valid only for Crew
  Intake. `system` is valid only for internally produced direct Inbox items.
- `sourceMember` and `targetMember` are execution-time trusted Membership or
  manifest snapshots, never public arguments or wire Origin. Each name/role is
  NFC, single-line, trimmed, 1–256 UTF-8 bytes, and free of NUL/C0/C1 controls.
  If the fixed sensitive-text detector or a reserved marker matches one of
  these trusted identity fields, capture fails as `invalid-capture` instead of
  persisting a modified/secret-bearing identity; the original operation remains
  unchanged and the endpoint records the evidence gap.
- `targetMember` is null only for a Broadcast summary/no-recipient event or a
  system event without one recipient. Per-recipient Broadcast events name one
  exact target.
- `claimedOrigin.state` is `absent`, `captured`, or `invalid`. `value` is null
  unless captured. A captured Crew Origin has exact `kind,name,role`; an
  External Origin has exact `kind,label`. Origin identity fields use the same
  1–256-byte NFC/single-line/control bounds but remain claimed attribution.
  Each claimed string applies marker escaping and the fixed detector before
  storage; `claimedOrigin.redactions` records canonical `{kind,occurrences}`
  credential/secret entries and is always present. For `absent`/`invalid`,
  `value` is null and `redactions` is empty. Invalid Origin bytes are omitted with state
  `invalid`; they never suppress the mechanical event.
- `deliveryIntent` is `follow-up`, `redirect`, or null. Only Follow-up, Member
  Request/Response, Inbox/Broadcast/Intake handoff, and Interrupt recovery use
  `follow-up`; only Redirect uses `redirect`. The value never changes because
  logging failed.

### Stable IDs, correlation, and replay

Raw operation, delivery, request, Inbox, Broadcast, Interrupt, tool-call,
session, socket, and callback IDs are never persisted. The active-layout Log
scope is:

```text
logScope = sha256(UTF8(realpath(active Crew layout directory)))
```

For one logical operation with its existing stable native ID:

```text
operation.id = "op-" + sha256(
  UTF8("crew-message-log:v1\0" + logScope + "\0" + surface + "\0" + nativeOperationId)
)

entry.id = "entry-" + sha256(
  UTF8("crew-message-log:v1\0" + operation.id + "\0" + stage + "\0" + lifecycleSequence)
)
```

The native ID is validated as 1–256 UTF-8 bytes before hashing and is never
used as a path or rendered. `lifecycleSequence` is a positive safe integer,
unique and monotonically increasing within one operation. The shared operation
allocates it from durable operation state; exact retry of one transition reuses
it, while a later distinct failure/success transition receives the next value.
Broadcast recipient sequences follow frozen manifest order, never response
arrival order.

A correlation is one closed `{kind,id}` object. `kind` is
`request | response | inbox-item | broadcast | interrupt | parent-event` and
`id` is `ref-` plus the scoped SHA-256 of its validated native ID. At most eight
unique correlations are retained, sorted by enum order then raw ASCII ID.
Required correlation overflow fails capture into the endpoint gap ledger rather
than silently dropping links.

`semanticFingerprint` is SHA-256 over canonical Message Event bytes excluding
`capture` and `semanticFingerprint`. Therefore the first endpoint to persist a
valid event retains its capture provenance; another endpoint/retry with the
same entry ID and semantic fingerprint is exact replay and returns the first
bytes unchanged. The same ID with a different semantic fingerprint is
`id-conflict`, never overwrite or second truth. Its failed capture attempt
enters the observer's gap ledger.

Replay/conflict guarantees apply while the Entry or its retention tombstone is
retained. A tombstone contains only entry ID, semantic fingerprint, original
occurrence/expiry instants, and prune reason; it never contains payload.

### Error and aggregate details

`errorCode` is null unless outcome is `failed`. A failed Event uses exactly one
`MessageEventErrorCodeV1` value:

```text
aborted | abort-failed | already-pending | already-terminal |
ambiguous-member | ambiguous-request | ambiguous-role | buffer-capacity |
capacity-exceeded | duplicate-request | external-intake-disabled |
handoff-failed | idempotency-conflict | inbox-full | inbox-untrusted |
inbox-untrusted-path | inbound-capacity | intake-storage-failed |
invalid-ack | invalid-item-id | invalid-json | invalid-manifest |
invalid-max-wait | invalid-payload | invalid-request | invalid-request-id |
invalid-timeout | item-not-found | no-context | no-pending-request |
not-a-member | not-joined | outcome-unknown | outbound-capacity |
read-failed | remote-rejected | response-expired |
response-wait-requires-member-request | self-interrupt | self-send |
storage-failed | storage-unavailable | transport-error | unknown-contact |
unknown-member | unknown-request | unknown-sender | untrusted-path |
untrusted-project | unexpected-failure
```

An underlying typed code with the exact same spelling is preserved. Any
unlisted, malformed, dependency-owned, or untyped cause maps only to
`unexpected-failure`; adding another preserved code requires a new schema
version. Capture-only codes (`invalid-capture`, `capture-capacity`,
`id-conflict`, `lock-conflict`, `write-failed`) belong only to capture-gap
records and are never Message Event error codes. Raw
message/cause/stack/path/dependency output is never present.

`summary` is null except a Broadcast summary, where it is the closed object:

```json
{
	"recipientCount": 3,
	"persistedCount": 2,
	"alreadyPersistedCount": 0,
	"failedCount": 1
}
```

Counts are non-negative safe integers, their sum equals `recipientCount`, and
`recipientCount` is 0–32. The summary is not a recipient list, completion
claim, preference signal, or replacement for per-recipient entries.

## Visible payload representation

### Inclusion

Exactly these events own payload representation:

- `delivery` for Follow-up, Redirect, Member Request, and Member Response;
- `persistence` for direct Member Inbox and Crew Intake;
- `recovery` for Interrupt's pending/direct recovery message;
- `broadcast-summary` for Crew Broadcast.

All other events have `payload:null` and link through operation/correlations.
This prevents repeating content on every lifecycle transition. If a
payload-owning Entry is not captured, later events do not reconstruct it; the
capture gap remains honest.

### Closed payload shape and limits

`payload` is null only for a non-payload-owning lifecycle event. A
payload-owning event uses exactly one branch of this closed discriminated union;
all listed keys are present:

```text
RepresentedPayload = {
  state: "represented",
  reason: null,
  content: CapturedText | UnavailableText,
  instructions: Array<CapturedText | UnavailableText>,
  instructionCount: integer
}

UnavailablePayload = {
  state: "unavailable",
  reason: "invalid-payload" | "record-capacity",
  content: UnavailableText,
  instructions: Array<UnavailableText>,
  instructionCount: null | integer
}
```

For `invalid-payload`, content reason is `invalid-payload`, instructions is
empty, and instructionCount is null because no valid source shape is trusted.
For `record-capacity`, content and every original instruction position use the
`record-capacity` UnavailableText shape, instructions length equals exact
instructionCount, and instructionCount remains `0..32`. No branch may omit,
join, or reorder an original valid instruction position. This reduced branch is
well below the 64 KiB Event bound.

`CapturedText` and `UnavailableText` share these exact keys:
`state,reason,text,normalizedUtf8Bytes,retainedUtf8Bytes,omittedUtf8Bytes,
truncated,escapedMarkerCount,redactions`. Captured state requires
`state:"captured"`, `reason:null`, non-null text/byte counts, and the exact
truncation arithmetic below. Unavailable state requires `state:"unavailable"`,
`text:null`, one closed reason, null normalized/omitted byte counts, retained
bytes zero, truncated false, escaped-marker count zero, and empty redactions.
No text-representation key is omitted.

`payload.content` and each `payload.instructions[index]` are bounded text
representations. Instructions retain original order and array positions.

- Source input is the already accepted strict `MessagePayload`: at most
  1,000,000 aggregate UTF-8 bytes, at most 32 instructions, and no callback
  fields are copied.
- Content text retains at most **4,096 UTF-8 bytes** after normalization and
  redaction.
- Each of at most 32 instruction texts retains at most **1,024 UTF-8 bytes**
  after normalization and redaction.
- A Message Event's canonical JSON is at most **64 KiB**. First build the
  `represented` branch after every per-text limit. If its canonical Event bytes
  exceed 65,536, replace the entire payload with the exact `record-capacity`
  `UnavailablePayload` branch above and recompute once; identity/lifecycle
  evidence remains. If that fixed reduced Event still exceeds 65,536, capture
  fails as `invalid-capture` and enters the endpoint gap ledger—no third shape
  or field omission is permitted.
- `instructionCount` is the exact source count `0..32`. Every position is
  represented as captured or unavailable; instructions are never reordered,
  deduplicated, joined, or inferred.

A captured text representation has exact fields shown above. An unavailable
representation is:

```json
{
	"state": "unavailable",
	"reason": "invalid-unicode",
	"text": null,
	"normalizedUtf8Bytes": null,
	"retainedUtf8Bytes": 0,
	"omittedUtf8Bytes": null,
	"truncated": false,
	"escapedMarkerCount": 0,
	"redactions": []
}
```

The closed unavailable reasons are `invalid-payload | invalid-unicode |
unsupported-control | record-capacity`. Content unavailability does not require
instruction unavailability, or vice versa. Unknown/raw cause text is absent.

### Exact normalization and redaction pipeline

Each content/instruction string is processed independently in this order:

1. Validate a well-formed Unicode scalar sequence. An unpaired surrogate yields
   `invalid-unicode`; do not repair or persist its text.
2. Reject from representation (not from message delivery) NUL; C0 controls
   U+0001–U+0008, U+000B, U+000C, U+000E–U+001F; DEL U+007F; and C1 controls
   U+0080–U+009F. Tab U+0009, LF U+000A, and CR U+000D remain supported.
3. Normalize CRLF and lone CR to LF, then Unicode to NFC. Preserve all other
   leading/trailing/embedded whitespace. `normalizedUtf8Bytes` measures these
   complete normalized bytes before marker escaping/redaction.
4. Before detectors, escape each exact user-authored literal
   `[REDACTED:credential]` or `[REDACTED:secret]` by inserting one backslash
   before its opening bracket. Existing backslashes remain, so an already
   escaped literal gains another backslash. Record the replacement count in
   `escapedMarkerCount`. This distinguishes user text from Bebop markers.
5. Build one non-overlapping replacement plan against the complete
   marker-escaped normalized string using ECMAScript 2024 RegExp semantics.
   These exact literals and flags are normative (no implicit `u`, `m`, `s`, or
   locale rules):

    ```js
    /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@/\s]+)@/gi
    /\b(authorization\s*:\s*bearer)\s+([A-Za-z0-9._~+/=-]{6,})/gi
    /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
    /\bAKIA[0-9A-Z]{16}\b/g
    ```

    Scan patterns in that order and each pattern left-to-right using its global
    `lastIndex`. A candidate claims its complete match interval only when it
    overlaps no interval already claimed by the same or an earlier pattern;
    otherwise skip it. Detectors always scan the one pre-replacement string, so
    Bebop markers inserted by one detector are never input to a later detector.

6. Render accepted intervals left-to-right with these exact replacements,
   copying every unmatched code unit unchanged:
    - pattern 1: `[REDACTED:secret]`;
    - pattern 2: captured group 1, then `[REDACTED:credential]@`;
    - pattern 3: captured group 1, one ASCII space, then
      `[REDACTED:credential]`;
    - pattern 4: captured group 1 followed by captured group 2, then
      `[REDACTED:credential]`;
    - pattern 5: `[REDACTED:credential]`.

    Captured groups preserve their exact matched casing/spacing. Match
    boundaries are UTF-16 code-unit offsets supplied by ECMAScript; validation
    in step 1 guarantees replacement cannot split a surrogate pair.

7. Count accepted replacements by class (pattern 1 is `secret`; patterns 2–5
   are `credential`). Record positive safe counts in canonical unique order
   `credential`, then `secret`, as `{kind,occurrences}`. Skipped overlaps and
   escaped user markers do not contribute. Counts describe replacements even
   when later byte truncation omits a rendered marker.
8. Truncate only after redaction at a valid UTF-8 boundary to the field limit.
   No inline truncation marker is appended. `retainedUtf8Bytes` measures stored
   text; `omittedUtf8Bytes` is exact post-redaction bytes minus retained bytes;
   `truncated` is exactly whether omitted bytes are positive.

The detector is bounded defense-in-depth, not proof that content is safe.
Guidance must still prohibit submitting credentials/secrets. Raw pre-redaction
bytes never enter IDs, fingerprints, filenames, diagnostics, output, or other
stores through this feature.

## Canonical bytes and deterministic ordering

- All UTC instants are exact `YYYY-MM-DDTHH:mm:ss.sssZ` and round-trip through
  ISO UTC parsing. All integers are non-negative safe integers unless a positive
  bound is stated.
- Canonical JSON recursively sorts object keys by raw UTF-8 byte order, keeps
  array order, uses RFC 8259 escapes, UTF-8 without BOM, no insignificant
  whitespace, and exactly one trailing LF for each persisted record.
- Fingerprint input omits only fields explicitly named by the record contract
  and has no trailing LF. Unknown/undefined/non-finite values fail closed.
- Canonical query order is ascending
  `(occurredAt, operation.id, operation.lifecycleSequence, id)`. This is a
  deterministic evidence order, not proof of atomic real-world chronology.
  Per-operation lifecycle sequence remains visible when clocks tie/regress.
  Filesystem enumeration, append completion, and endpoint response arrival
  never decide order.
- Duplicate IDs with equal fingerprints collapse by replay; conflicting bytes
  are never silently ordered as two facts.

## Capture epochs, checkpoints, and gaps

### Endpoint identity and attempts

Each joined capturing endpoint derives:

```text
endpointId = "endpoint-" + sha256(
  UTF8("crew-message-log:endpoint:v1\0" + logScope + "\0" + exactMemberName)
)
epochId = "epoch-" + sha256(
  UTF8("crew-message-log:epoch:v1\0" + endpointId + "\0" + injectedCaptureEpochId)
)
```

The injected capture epoch ID is 1–128 ASCII characters matching
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; it is not a session ID and is never
persisted raw. Role is excluded from endpoint identity. One live Membership
endpoint owns one epoch. Its positive safe `attemptSequence` increments exactly
once before every Event/marker append attempt, including exact replay,
conflict, and store failure. It never rolls back or reuses a number in one
epoch.

Lifecycle markers are immutable canonical records with the same version,
UTC/canonical-byte/retention rules. Except for the separately closed Coverage
Snapshot, every marker has exactly this top-level shape:

```json
{
	"version": 1,
	"kind": "capture-gap",
	"id": "marker-<64 lowercase hex>",
	"occurredAt": "2026-08-28T12:01:00.000Z",
	"endpointId": "endpoint-<64 lowercase hex>",
	"epochId": "epoch-<64 lowercase hex>",
	"attemptSequence": 43,
	"details": {},
	"semanticFingerprint": "<64 lowercase hex>"
}
```

All keys are present. Endpoint/epoch/attempt are null only for a
`retention-gap`. `details` is exactly one closed kind-specific object:

- `epoch-open`: `{openedAt,priorMarkerId}`, where `priorMarkerId` is null or one
  marker ID.
- `coverage-checkpoint`: `{intervalEnd,lastAttemptSequence}`.
- `epoch-clean-close`: `{closedAt,lastAttemptSequence}`.
- `capture-gap`:
  `{cause,firstSequence,lastSequence,firstOccurredAt,lastOccurredAt,attemptCount}`.
- `unverified-capture`:
  `{priorEpochId,priorMarkerId,interval:{start,end},eventCount:null}`, where
  prior IDs are null or their closed scoped IDs.
- `retention-gap`:
  `{interval:{start,end},removedEventCount,removedCanonicalBytes,reason,detailsTruncated}`;
  counts are null or non-negative safe integers and reason is exactly `age`,
  `capacity`, or `corruption`.

The marker ID is:

```text
"marker-" + sha256(UTF8(
  "crew-message-log:marker:v1\0" + logScope + "\0" + kind + "\0" +
  (endpointId ?? "-") + "\0" + (epochId ?? "-") + "\0" +
  (attemptSequence ?? "-") + "\0" + canonicalJson(details)
))
```

`semanticFingerprint` hashes all canonical marker fields except itself. Exact
ID/fingerprint replay returns the first bytes; mismatch conflicts without
replacement. A marker cannot contain payload, Origin, Role/system instructions,
raw error, route, path, or native ID. `coverage-snapshot` uses its separately
closed shape below.

A capacity-pruned Event creates internal replay metadata with the exact closed
shape `{version:1,kind:"retention-tombstone",entryId,semanticFingerprint,
occurredAt,expiresAt,prunedAt,reason:"capacity"}`. Tombstones are not Log
Entries or query results and contain no payload/attribution/correlation.

### Volatile gap ledger

If an Entry/marker append fails after its attempt sequence is allocated, the
endpoint records no raw payload/error. It merges a range into an in-memory
ledger by exact `(endpointId,epochId,cause)` when sequences are adjacent. Closed
causes are:

`store-unavailable | lock-conflict | write-failed | id-conflict | invalid-capture | capture-capacity | details-truncated`

A range is:

```json
{
	"firstSequence": 40,
	"lastSequence": 42,
	"firstOccurredAt": "2026-08-28T12:00:00.000Z",
	"lastOccurredAt": "2026-08-28T12:01:00.000Z",
	"attemptCount": 3
}
```

The ledger contains at most 256 ranges after adjacency merge. Before adding a
257th, the oldest ranges are deterministically coalesced by sequence into one
wider `details-truncated` range; it preserves minimum/maximum sequence/time and
exact summed attempt count but does not claim one cause. A successful store
boundary persists every ledger range in sequence order before the later Event,
checkpoint, or close in the same lock transaction. Only durable gap markers are
removed from memory. Later Event bytes never appear ahead of an unflushed known
gap.

Capture failure never changes the original operation's outcome, mode, FIFO,
Response, cancellation, cleanup, exit status, or success/error classification.
A bounded safe evidence diagnostic may be emitted separately; it cannot include
payload, raw exception, path, socket, callback, or native IDs and cannot promise
recovery.

### Crash/restart truth

A clean close proves only that the endpoint durably recorded its last attempted
sequence at that boundary. It does not prove message completion or future
coverage.

On successful epoch open:

- a prior clean close needs no unverified marker;
- a prior open/checkpoint without later clean close produces
  `unverified-capture` from that marker's UTC instant to the new open; exact
  event count is null because volatile attempts may have been lost;
- no durable prior marker does not prove that a process existed. The new open is
  the first provable coverage point.

For a review interval beginning before an endpoint's first durable marker, the
coverage snapshot reports `unknown-before-first-marker` from interval start to
that marker. If no marker exists, the endpoint outcome is offline/timeout/
unavailable as mechanically observed; absent Log bytes never mean no activity.

## Retention and capacity

### Exact bounds

The active-layout Log retains evidence for at most **30 consecutive 24-hour
UTC durations** (`2,592,000,000 ms`) and is additionally bounded by:

- **8,192** healthy Message Events;
- **2,048** healthy lifecycle/gap/coverage records;
- **32,768** retention tombstones;
- **64 MiB** (`67,108,864`) canonical healthy bytes across Events, markers,
  snapshots, and tombstones;
- **64 KiB** per Message Event or coverage snapshot;
- **16 KiB** per other lifecycle/gap record or tombstone.

No flag, tool, command, review, or maintenance read exposes unlimited history.

### Retention operation

Retention runs only inside the same bounded exclusive write transaction as a
new Entry/marker append or an explicit trusted maintenance operation. Reads,
join, restore, prompt construction, and review queries never prune, repair,
checkpoint, or create directories.

`retentionNow` is `max(injectedNow, persistedRetentionHighWatermark)`. Clock
rollback cannot resurrect evidence or move the cutoff backward. The age cutoff
is `retentionNow - 2,592,000,000 ms`; records with `occurredAt < cutoff` expire,
while equality remains retained.

Within one write transaction:

1. validate trust/layout and the complete incoming canonical record;
2. acquire the bounded store lock;
3. persist known volatile gap ranges first;
4. expire records/tombstones strictly before the age cutoff;
5. if an Event/count/byte bound would still be exceeded, prune oldest Message
   Events by `(occurredAt,id)` until the incoming record fits;
6. create/merge retention-gap evidence and one tombstone for each capacity-
   pruned Event before publishing the incoming record;
7. publish atomically with no replacement, then advance the retention high-water
   mark.

Age-expired Events need no tombstone after their 30-day idempotency window.
Capacity-pruned Events retain tombstones until their original occurrence plus
30 days. If tombstone/marker/byte capacity cannot preserve honest replay and
pruning evidence, the **capture append fails** as `capture-capacity`; the
original messaging outcome remains unchanged and the endpoint ledger records
the gap. The store never silently drops a gap/tombstone to claim success.

Retention-gap records merge adjacent/overlapping intervals with the same reason
and exact count availability. At most 256 distinct retained gap ranges are
rendered by a query; overflow coalesces oldest ranges and marks
`detailsTruncated:true` while preserving overall first/last interval and summed
known counts. Pruning never changes Inbox, Crew Board, Agreements,
Retrospective Records, or message delivery state.

## Storage safety requirements

TASK-0129 owns implementation, but v1 storage must preserve these product
bounds:

- One exclusive write lock uses a 2,000 ms injected-monotonic absolute deadline
  and 25 ms retry interval. V1 never steals/deletes a lock from wall-clock age,
  PID, Member Presence, or guessed liveness. Release removes only the caller's
  verified owner token.
- Atomic publication is same-filesystem, durable, and no-replace. Temp cleanup
  removes only the current verified owner. Unsupported durability/no-replace
  semantics fail capture rather than claim persistence.
- One bounded scan examines at most 50,000 healthy/tombstone/marker records and
  checks canonical byte size before full parse. Directory overflow is
  `capture-capacity`, never a partial successful scan.
- Invalid/unsupported/tampered records are never returned as evidence. A read
  reports them as corruption gaps without mutation. The next write or explicit
  trusted maintenance operation may quarantine them under the same lock before
  publishing new bytes.
- Quarantine retains at most 256 files and 16 MiB. It uses hash-derived safe
  names, never exposes rejected basename/content/path, and never counts as Log
  evidence. If quarantine cannot preserve the invalid artifact within bounds,
  the write/maintenance operation fails; no healthy Entry is fabricated or
  overwritten. Reads remain mutation-free and report the unavailable corrupt
  range.
- All filesystem, clock, hashing, locking, and atomic-publication dependencies
  are injected. Failures use safe closed codes and never include payload,
  absolute path, socket, stack, or dependency text.

## Trusted layout and access

The Log exists once beside the active trusted manifest:

```text
.pi/bebop/message-log/
```

or compatibility layout:

```text
.pi/crew/message-log/
```

Only the layout selected by current trusted Membership is opened. Bebop never
copies, mirrors, merges, discovers, or falls back to the inactive layout. A
layout switch selects only the new active Log.

- Trust, containment, supported-layout, symlink, and manifest validation happen
  before Log IO.
- Internal capture may append for authenticated Member operations, external
  Crew Intake, or system-produced Inbox events. Public callers cannot supply
  Log identity/attribution or append bytes.
- A missing read is the canonical empty result and creates no directory, lock,
  checkpoint, retention update, or read state.
- Every Current Member may read all still-retained active-layout history.
  Join/rejoin time and capture-time roster do not filter history. Leaving,
  removal, inactive Membership, or layout change removes/rejects application
  access before Log IO.
- Prior Entries keep append-time Membership/Role attribution. Later Role change
  changes only later Entries. Role, Crew contact, facilitator, claimed Origin,
  Presence, or Activity cannot alter access.
- Joined/discovery guidance must say that retained history predating Membership
  is visible to every Current Member. It must not preload content/counts or
  start a model turn.

## Pre-review coverage snapshot

Coverage collection is an explicit TASK-0130 capture/write operation named
`collectCrewMessageLogCoverage`. TASK-0131 readers cannot invoke it.

Input freezes one exact active-layout Log scope, half-open UTC interval
`[start,end)`, manifest-order roster of at most 32 exact Member names, and stable
review/collection operation identity. It concurrently requests one checkpoint
from every frozen endpoint (the local Member uses the same local seam) under
one fixed **5,000 ms operation-wide monotonic deadline**.

Each roster slot has exactly one outcome:

`checkpointed | offline | timeout | unavailable | identity-mismatch`

A checkpointed slot records endpoint/epoch/checkpoint IDs, last attempted
sequence, checkpoint UTC instant, and referenced durable gap IDs. Other slots
record no guessed epoch/sequence and only their closed outcome plus safe code
when known. Roster order is preserved; Role is recorded attribution only.
Coverage also reports `unknown-before-first-marker`, unclean epoch intervals,
retention gaps, corrupt/unavailable store ranges, and whether any counts were
coalesced. It never fills absent intervals with zero.

Each endpoint outcome is persisted idempotently before snapshot freeze. The
snapshot is the closed canonical object:

```json
{
	"version": 1,
	"kind": "coverage-snapshot",
	"id": "coverage-<64 lowercase hex>",
	"reviewOperationId": "ref-<64 lowercase hex>",
	"interval": {
		"start": "2026-08-21T00:00:00.000Z",
		"end": "2026-08-28T00:00:00.000Z"
	},
	"roster": [
		{
			"member": { "name": "Mary", "role": "po" },
			"outcome": "checkpointed",
			"safeCode": null,
			"endpointId": "endpoint-<64 lowercase hex>",
			"epochId": "epoch-<64 lowercase hex>",
			"checkpointId": "checkpoint-<64 lowercase hex>",
			"lastAttemptSequence": 42,
			"observedAt": "2026-08-28T00:00:01.000Z",
			"gapIds": []
		}
	],
	"gaps": [],
	"gapCount": 0,
	"gapCountTruncated": false,
	"corruptRecordCount": 0,
	"corruptCountTruncated": false,
	"createdAt": "2026-08-28T00:00:05.000Z",
	"entriesRootHash": "<64 lowercase hex>",
	"snapshotHash": "<64 lowercase hex>"
}
```

Every roster-slot key shown is present. `safeCode` is a closed nullable
`CoverageSafeCodeV1`:

```text
null | checkpoint-timeout | endpoint-offline | endpoint-unavailable |
identity-mismatch | invalid-checkpoint | store-unavailable |
unexpected-failure
```

`checkpointed` requires null; `offline` requires `endpoint-offline`; `timeout`
requires `checkpoint-timeout`; `identity-mismatch` requires
`identity-mismatch`; `unavailable` requires exactly one of
`endpoint-unavailable | invalid-checkpoint | store-unavailable |
unexpected-failure`. Unlisted causes map to `unexpected-failure`; a new
preserved code requires a schema version change.

Non-checkpointed slots use null for endpoint/epoch/checkpoint/sequence, retain
`observedAt`, and may reference already durable gaps. `gapIds` contains at most
256 canonical unique marker IDs in marker order.

`gaps` contains at most 256 closed summaries
`{kind,interval:{start,end},endpointId,eventCount,markerIds,detailsTruncated}`.
Kind is `capture | unverified-capture | unknown-before-first-marker | retention |
corruption | store-unavailable | details-truncated`; endpoint ID and event count
are nullable, marker IDs are canonical/sorted and capped at 256, and no summary
contains payload. Summaries order by `(interval.start,interval.end,kind,
endpointId-or-empty)`. Above 256, the oldest summaries become one
`details-truncated` summary with minimum start, maximum end, null endpoint,
empty marker IDs, and exact summed event count only when every source count was
known; the newest 255 remain exact. `gapCount` is the exact pre-coalescing count
up to the safe-integer bound; `gapCountTruncated` states that summaries were
coalesced. Corrupt count
clamps at 50,000 and its flag states that the scan bound prevented an exact
higher count. `entriesRootHash` hashes the canonical ordered
`(entry.id,semanticFingerprint)` list intersecting the interval at freeze; it
does not embed content.

Snapshot ID derives from scoped stable review operation identity plus exact
interval/roster hash. `snapshotHash` hashes canonical snapshot bytes excluding
itself. Exact retry returns the same snapshot. A conflicting/late endpoint
reply never replaces a frozen slot or snapshot. Restart resumes the stable
collection identity and existing per-slot records; it does not duplicate
checkpoint effects. If the snapshot itself cannot be persisted, review does
not claim a frozen snapshot and must fail/start later with explicit evidence
error; message delivery remains unaffected.

TASK-0131 receives only immutable snapshot ID/hash and Log reader dependencies.
Its tool, slash command, and Retrospective adapter have no endpoint, checkpoint,
capture, append, flush, retention, lifecycle, Inbox, or repair capability.

## Pull inspection contract

V1 inspection is explicit and non-consuming:

- default page limit 20; valid range 1–100;
- fixed half-open UTC interval is required for Retrospective reads and defaults
  to the retained interval for direct inspection, capped to 30 days;
- allow-listed filters are exact Member name, surface, outcome, direction
  (`sent | received | external | system`), and stable cursor;
- metadata is default; visible payload requires explicit `includeContent:true`;
- cursors bind Log scope, filters, include-content mode, and the last canonical
  ordering key, are base64url without padding, and are at most 1,024 ASCII
  bytes;
- results report retained range, matching/scanned counts, retention gaps,
  capture gaps, corruption/unavailable state, per-endpoint coverage from the
  supplied immutable snapshot when applicable, and truncation/coalescing flags;
- no read records a cursor, receipt, readership, notification, query, or Log
  Entry; no read requests a checkpoint or applies retention;
- repeated reads against unchanged retained bytes/snapshot and identical input
  are byte-equivalent.

Content opt-in exposes only the already redacted/bounded representation. It
never reopens raw payload, expands omitted bytes, or offers a `--full`/unlimited
mode.

## Messaging Review semantics

A **Messaging Review** is an explicitly started, fixed-interval learning record.
It invokes TASK-0130 coverage collection before TASK-0131 reads, then combines:

1. immutable mechanical Log evidence and explicit gaps;
2. optional authenticated, attributed feedback requested identically from every
   frozen-roster Member through existing Member Request/Response semantics;
3. separately labelled candidate interpretations;
4. separately labelled falsifiable proposals or Trial Agreements.

Frequent use never proves satisfaction. Non-use/silence never proves dislike.
Failure never proves Member fault. Timeout/offline/missing/late feedback never
means agreement or consent. Direct Member statements remain attributed and may
conflict. Review publication, Inbox announcement, Retrospective linkage, and
feedback deadline/retry rules are owned by TASK-0132; no review automatically
changes delivery defaults, tools, templates, Agreements, or instructions.

## Failure and restart matrix

| Situation                                | Required result                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Delivery succeeds; Log append fails      | Delivery success remains; volatile gap range records the failed evidence attempt                           |
| Delivery fails with known code           | `failed` event with safe typed code if capture succeeds; no raw error                                      |
| Exact adapter/endpoint retry             | One Entry; same semantic fingerprint returns first bytes                                                   |
| Same Entry ID, different semantics       | Stable `id-conflict`; no overwrite; observer gap range                                                     |
| Concurrent endpoint observations         | First valid capture provenance retained; semantic replay converges                                         |
| Crash with clean close                   | Close is last proved endpoint boundary; no future/complete claim                                           |
| Crash without clean close                | Next epoch records unverified interval with unknown event count                                            |
| Endpoint never created durable marker    | Coverage reports unknown/offline/timeout/unavailable; absence is not zero activity                         |
| 257th volatile gap range                 | Oldest ranges coalesce deterministically as details-truncated with exact range/count bounds                |
| Clock moves backward                     | Retention high-water mark does not move; occurrence instants remain source facts                           |
| Event reaches age cutoff equality        | Retained at equality; expires only when strictly older                                                     |
| Event/byte capacity reached              | Oldest Event pruning plus tombstone/gap; fail capture if honest metadata cannot fit                        |
| Member joins after capture               | May read all retained active-layout history                                                                |
| Member leaves during read                | Reject before/result publication; no partial unauthorized result                                           |
| Role changes                             | Visibility unchanged; later attribution changes only later Events                                          |
| Both layouts exist                       | Active Membership layout only; no merge/fallback                                                           |
| Invalid/symlinked/untrusted layout       | Reject before Log IO                                                                                       |
| Generic session traffic occurs           | No Entry; excluded by inventory rather than incidental partial capture                                     |
| Secret/reserved marker/oversized Unicode | Deterministic escape/redaction/truncation or explicit unavailable representation; mechanical event remains |
| Read/review occurs                       | No checkpoint, retention, append, read state, notification, or model turn                                  |
| Coverage reply is late/conflicting       | Frozen slot/snapshot unchanged                                                                             |
| Store/snapshot unavailable               | Explicit evidence gap/failure; never fabricated completeness                                               |

## Explicitly deferred

- caller-authored append/edit/delete, Member-private entries, ACLs, Role tiers,
  moderators, read receipts, unread counters, notifications, live tailing, or
  automatic prompt injection;
- generic Pi/session traffic, provider/model internals, hidden reasoning,
  system/Role prompts, raw tool traces, sockets, callbacks, or packet capture;
- employee monitoring, productivity/performance/quality scoring, sentiment or
  intent inference, preference prediction, consensus inference, or Member
  ranking;
- unbounded transcripts/search/export, remote/network/cloud replication,
  cryptographic sender authentication, and OS filesystem confidentiality;
- automatic product decisions, delivery/default changes, Agreement activation,
  task creation, or Retrospective start/completion;
- semantic deduplication of different operation IDs or truth/conflict
  resolution from message content.

## Planned implementation slices

- TASK-0129 — trusted bounded active-layout storage, replay, retention, gaps, and
  corruption handling;
- TASK-0130 — shared application capture, endpoint epochs/checkpoints, immutable
  pre-review coverage snapshot, and TASK-0112 source;
- TASK-0131 — pull-only tool/slash/Retrospective readers with no mutation
  capability;
- TASK-0132 — first fixed-interval Messaging Review with authenticated Member
  feedback and falsifiable improvement trials.
