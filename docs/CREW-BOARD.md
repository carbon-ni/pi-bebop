# Crew Board

Status: **implemented (v1 local Crew Board)**.

Use the [STE100 profile](STYLE.md) when you edit this reference. Keep post fields, schemas, and fixed values exact.

## Problem

Some project context does not belong in formal documentation or a direct Member message. A direct message interrupts work. One Pi session does not retain shared context.

A shared board can retain this context. It must not become a delivery channel, task system, rating system, or source of authority.

## Desired outcome

Every Current Member can append practical tips, kudos, feedback, warnings, and ordinary notes to one durable project-local **Crew Board**. Every Current Member can pull the same bounded **Crew Posts** later. Reading or appending never selects recipients, delivers a message, starts a turn, requests a Response, records readership, or changes project workflow.

```text
Current Member appends Crew Post
  -> one shared manifest-adjacent Crew Board
  -> any Current Member explicitly reads a bounded page
```

## Use deliberately

Read only when starting unfamiliar work or seeking project context; append only a reusable `tip`, `kudos`, `feedback`, `warning`, or `note` worth retaining beyond this session. Posts are attributed, fallible statements—not instructions, tasks, ratings, or proof.

Agent tools:

```text
read_crew_board({ kinds?: ["tip"], after?: "<cursor>", limit?: 20 })
leave_crew_post({ kind: "tip", message: "Run make all before push", references: ["Makefile"] })
```

Human commands:

```text
/crew board --kind tip --limit 20
/crew post --kind tip --ref Makefile Run make all before push
```

The Board is pull-only: neither command nor tool sends, delivers, notifies, marks read, starts a model turn, or promotes a Post. If a write is interrupted, retry the same tool invocation only when its operation identity is preserved; otherwise inspect the Board first. A `lock-conflict`, corrupt record, or quarantine failure is an honest bounded error: do not delete lock/temp/post files manually. A trusted maintenance operation, after an operator establishes no live owner, is required for stale-lock recovery.

## Product boundaries

- Crew Membership is the only Bebop application access boundary. Every Current Member has identical read-and-append capability; there are no private posts, per-Member ACLs, Role permissions, owners, moderators, or read/write tiers.
- A Crew Post is an attributed Member statement, not automatically verified truth. A `tip`, `kudos`, `feedback`, `warning`, or `note` label changes filtering/rendering only.
- Crew Board is pull-based. It has no recipient, delivery state, read receipt, unread counter, acknowledgement, acceptance, response obligation, notification, or automatic model-context content.
- Crew Posts are not Member messages, Inbox items, Crew Broadcasts, Member requests, task/plan state, AGENTS.md guidance, Current Crew Agreements, or Agreement activation operations.
- Role is append-time attribution only. Role, Origin, Presence, Activity, facilitator status, or Lead convention cannot change Board access or post authority.
- Board access is not an operating-system security claim. A process with project filesystem access may read runtime files outside Bebop; Membership defines only the extension's read/append capability.
- Credentials and secrets must not be retained. Hidden model reasoning is unavailable and is never requested or summarized.

## Membership lifecycle

Bebop derives author identity and Board location from the active trusted Membership at operation time.

| Membership boundary                                       | Board result                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Join, restore, or rejoin succeeds                         | Same read-and-append operations become available to the Current Member        |
| Role or description changes on a later Membership         | Capability stays identical; new Posts capture the new append-time attribution |
| Member leaves, is removed, or Membership becomes inactive | Bebop removes/rejects Board operations before Board IO                        |
| Member joins after Posts already exist                    | Member may read the same retained Board history                               |
| Member goes offline after appending                       | Retained Posts remain; Board makes no claim that another Member saw them      |

Leaving never deletes or anonymizes prior Posts. A Member cannot use a claimed name, Role, Origin, or post field to author as another Member.

## Crew Post contract

### Canonical v1 shape

A persisted v1 Crew Post contains:

```json
{
	"version": 1,
	"id": "post-<opaque-stable-id>",
	"sequence": 42,
	"createdAt": 1779990000000,
	"author": { "name": "Mary", "role": "po" },
	"kind": "tip",
	"message": "Member requests reject self-targeting; use the local seam.",
	"references": ["TASK-0107"],
	"link": null,
	"redactions": [],
	"semanticFingerprint": "<sha256>"
}
```

Rules:

- `version` is exactly `1`; unknown versions and unknown fields fail closed.
- `id` is exactly `post-` plus 64 lowercase hexadecimal SHA-256 characters. It is board-scoped and derived from an injected append-operation identity. The raw operation identity, tool-call ID, session ID, socket, and filesystem path are never persisted or rendered.
- `sequence` is a unique positive safe integer allocated under the Board lock. It defines accepted append order; filesystem enumeration and response completion order do not.
- `createdAt` is the first accepted append's non-negative safe UTC epoch-millisecond integer. Retry never refreshes it.
- `author.name` and `author.role` are exact append-time active trusted Membership values, each 1–256 UTF-8 bytes, NFC, single-line, trimmed, and free of NUL/unsupported controls. They are dependencies of the operation and attribution only; public callers cannot supply or override them.
- `kind` is exactly `tip`, `kudos`, `feedback`, `warning`, or `note`; omission normalizes to `note`. Bebop never infers it from prose.
- `message` is canonical redacted UTF-8 text with a maximum of 4,096 UTF-8 bytes. The submitted raw message is capped at 16 KiB and must be valid Unicode without NUL/unsupported control data before normalization/redaction.
- `references` contains at most 16 unique safe project identifiers or normalized project-relative references, each at most 256 UTF-8 bytes. Absolute paths, traversal, home/global-session/socket paths, URLs with credentials, NUL, and any value matching the sensitive-text policy reject the entire append; references are never rewritten by redaction. A reference never imports or mutates its target.
- `link` is exactly `null` or one closed `{ "relation": "supersedes" | "disputes", "postId": "..." }` object to an earlier Post in the same Board. Unknown/missing relation fields, parallel links, self, future, missing, foreign-Board, and cyclic targets reject before publication.
- `supersedes` is valid only when new and target Posts have the same author name; another Member uses `disputes`. Either link appends context and never rewrites target bytes.
- `redactions` is the unique canonical-order subset of `credential | secret` detected while producing the persisted message. Empty means no known pattern changed the message.
- `semanticFingerprint` is SHA-256 over canonical semantic input: author, normalized kind, persisted redacted message, references, link, and redactions. It excludes raw submitted bytes, assigned ID, sequence, and time.

A canonical record is at most 16 KiB. The Board accepts at most 4,096 healthy Posts. Capacity failure is explicit; v1 never silently evicts, compacts, expires, or deletes a Post.

### Deterministic sensitive-text policy

Secret handling is **canonical redaction for the message and reject-before-write for references**—never an unspecified choice between rejection and redaction.

1. Reject non-string, unpaired Unicode surrogate, NUL/unsupported control data, reserved literal `[REDACTED:credential]`/`[REDACTED:secret]` markers, or raw message bytes above 16 KiB before normalization.
2. Normalize Unicode to NFC, line endings to LF, and remove leading/trailing whitespace. Reject empty normalized text.
3. Apply, in this fixed order, the existing deterministic Retrospective evidence patterns and markers:
    - PEM RSA/EC/OpenSSH private-key blocks -> `[REDACTED:secret]`;
    - URL user/password credentials -> preserve scheme and replace credentials with `[REDACTED:credential]@`;
    - `Authorization: Bearer <token>` where token is at least six supported token characters -> retain prefix and replace token with `[REDACTED:credential]`;
    - case-insensitive `password|passwd|pwd|token|secret|api_key|api-key|access_key|access-key` assignments -> preserve key/separator and replace value with `[REDACTED:credential]`;
    - AWS access-key IDs matching `AKIA` plus 16 uppercase alphanumeric characters -> `[REDACTED:credential]`.
4. Record which replacement classes actually ran in canonical unique order `credential`, then `secret`; do not infer redaction metadata from user-authored marker text.
5. Apply the 4,096-byte persisted-message bound after redaction; reject if empty/oversized.
6. Validate each reference with the same detector, but reject the append as `sensitive-reference` instead of persisting a transformed reference.
7. Fingerprint and conflict comparison use only the persisted redacted canonical form. Therefore the same operation replayed with raw secrets that canonicalize to identical redacted bytes is unchanged; the raw secret never enters ID, fingerprint, file, output, log, or error text.

The detector is bounded defense-in-depth, not a completeness or safety guarantee. Tool/help text still instructs Members not to submit credentials or secrets.

### Canonical bytes and fingerprint

Canonicalization is exact rather than implementation-selected:

- All accepted input strings are valid Unicode normalized to NFC. Message line endings normalize from CRLF/CR to LF; author/reference/kind/ID fields are single-line where their grammar requires it.
- References are sorted by raw UTF-8 byte order after validation. Redactions use fixed order `credential`, then `secret`. Object arrays never depend on filesystem/response order.
- Canonical JSON uses UTF-8 without BOM, JSON escapes required by RFC 8259, no insignificant whitespace, and one trailing LF for the persisted Post file.
- Persisted top-level key order is exactly `version,id,sequence,createdAt,author,kind,message,references,link,redactions,semanticFingerprint`; author order is `name,role`; non-null link order is `relation,postId`.
- `link` is always present as `null` or the closed link object. Empty `references` and `redactions` arrays are always present; optional fields are never omitted in a persisted v1 Post.
- Semantic fingerprint input is the compact JSON object with fixed key order `author,kind,message,references,link,redactions`, with nested key order above, encoded as UTF-8 without BOM or trailing LF.
- `semanticFingerprint` is lowercase 64-character SHA-256 hex over those exact fingerprint-input bytes.

The same canonical semantic values always produce the same fingerprint and Post bytes once the first ID, sequence, and createdAt are assigned.

### Safe reference grammar

A reference is ASCII only, 1–256 bytes, matches `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`, and then passes all structural checks:

- it does not start with `/`, `~`, a Windows drive prefix, or `.pi/`;
- it contains no `\\`, `//`, `://`, empty path segment, or `.`/`..` path segment;
- it contains no percent-encoding, query/fragment delimiter, `@`, whitespace, or control data (these are excluded by the grammar);
- all URL schemes and absolute filesystem forms are rejected;
- it does not match any sensitive-text pattern or reserved redaction marker;
- normalized duplicates reject, then accepted references sort by raw UTF-8 byte order.

Examples accepted: `TASK-0107`, `docs/CREW-AGREEMENTS.md`, `retrospective:retro-123`. Examples rejected: `../secret`, `/tmp/file`, `C:/file`, `.pi/bebop/board`, `https://example.test`, and `token:abc123` when the sensitive detector identifies it.

### Kinds carry no authority

| Kind       | Intended use                         | Explicitly does not mean                            |
| ---------- | ------------------------------------ | --------------------------------------------------- |
| `tip`      | Practical project-working guidance   | verified rule or required instruction               |
| `kudos`    | Positive attributed appreciation     | rating, reputation, performance evidence, reward    |
| `feedback` | Attributed improvement observation   | verdict, assignment, approval, personnel assessment |
| `warning`  | Claimed risk or trap worth checking  | security policy, incident truth, automatic block    |
| `note`     | Other bounded shared project context | task state, decision, instruction, notification     |

Kinds are never counted, ranked, scored, sentiment-analysed, or aggregated per Member. Conflicting Posts remain visible as attributed claims.

## Append operation identity and idempotency

Every append requires an infrastructure-supplied `operationId`; it is not a public Member argument. It is 1–128 ASCII characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Pi tool execution uses its stable tool-call identity; a slash/other adapter creates one injected invocation identity before calling the application operation. Tests inject it. A new human/tool invocation normally has a new identity even when text repeats.

The uniqueness scope is one active-layout Board for as long as its Post is retained. Derivation is:

```text
boardScope = sha256(UTF8(realpath(active layout directory)))
id = "post-" + sha256(UTF8("crew-board:v1\0" + boardScope + "\0" + operationId))
```

Both hashes are lowercase hexadecimal. Only derived `id` is persisted; raw operation ID, real path, and boardScope are not. Hex output makes the filename path-safe. Moving/copying a Board to another filesystem path establishes a different operation-identity scope; v1 is local storage, not replication.

Before any Board directory/file IO, the application operation requires an active trusted Membership snapshot containing exact name/role and exact manifest path, resolves that manifest's active layout, validates author bounds, and rejects any claimed author/Role or layout mismatch. Same-name identity defines supersedes ownership; an append-time Role change does not invalidate a Member's right to supersede their own earlier Post.

Append then validates operation identity, complete semantic input, limits, references, and link grammar. Under one bounded Board lock it first checks the derived Post ID for replay/conflict. Exact replay validates the existing canonical record and semantic fingerprint, then returns it without capacity/link revalidation, sequence allocation, clock read, temp write, or mutation. A new append validates its link target and capacity, allocates sequence/time, writes one temporary canonical file, and publishes without replacing an existing target.

Idempotency is operation-scoped, not content-wide:

- same append-operation identity plus the same canonical semantic fingerprint returns the first Post unchanged, including original sequence/time;
- same append-operation identity plus changed author, Role attribution, or other semantic input within that Board is stable `idempotency-conflict` and performs no overwrite;
- the same text submitted through a new append operation creates a distinct Post;
- crash before atomic no-replace publish creates no Post and may safely retry the same operation;
- crash after no-replace publish replays the one published Post.

Canonical append result is closed `{ "version":1,"post":<CrewPost>,"alreadyPersisted":boolean }`; exact replay sets `alreadyPersisted=true`, first publish sets false. A successful append means **persisted on the Board** only. It never means sent, delivered, read, accepted, agreed, correct, promoted, or acted upon.

## Reading and pagination

Reading is explicit, non-consuming, and shared. It creates no per-Member cursor/read state and does not change valid Posts. Infrastructure may quarantine invalid files; that repair never marks a healthy Post read.

- Default limit is 20; valid range is 1–100.
- Canonical listing order is newest first by `(sequence, id)` descending.
- Omitted `after` starts at the newest eligible Post.
- `after` is an opaque versioned Board-scoped cursor returned by a prior page. It continues strictly after that page's **last scanned healthy Post**, not merely the last returned kind match, in canonical listing order.
- A cursor is base64url without padding over compact fixed-order UTF-8 JSON `{ "v":1,"board":"<scope-hash>","sequence":42,"id":"post-...","kinds":[...] }`, at most 512 ASCII bytes. `kinds` is the canonical sorted filter or an empty array for all kinds. Raw paths are absent.
- Cursor Board scope/version/bounds/ID must validate. Continuation kind filters must equal the cursor filter; changing filters returns `cursor-filter-mismatch`. `limit` is not bound into the cursor and may change within 1–100.
- Kind filters contain 1–5 unique v1 kinds, normalize into enum order `tip,kudos,feedback,warning,note`, and affect inclusion only.
- Canonical result shape is closed `{ "version":1,"posts":[...],"nextCursor":null|"...","hasMore":boolean,"corruptCount":integer,"quarantinedThisRead":integer,"corruptCountTruncated":boolean }`. `nextCursor` anchors the last scanned healthy Post when continuation remains useful; both counts clamp to `0..4096`. Results never expose filenames, paths, rejected bytes, operation identities, or secret material.
- `hasMore` means at least one additional healthy Post matching the bound kind filter exists after the scan boundary; malformed/quarantined files never count. If scanning reaches the end with zero matches, `hasMore=false` and no continuation cursor is required.
- Concurrent newer appends sort before an existing cursor and do not shift that cursor's older continuation. Omit the cursor to refresh from newest.
- A boundary Post later quarantined does not invalidate the cursor: its validated sequence/ID still defines the strict ordering boundary. Invalid, foreign, unsupported-version, or malformed cursors reject before record scan/quarantine and without Board mutation.

Repeated reads with the same Board bytes and parameters are byte-stable. No result claims that any Member previously saw a Post.

## Corrections and disagreement

Crew Posts are immutable. Correction and disagreement are additional Posts:

- an author may append a Post that `supersedes` their own earlier Post; identity comparison uses exact Member name, not Role;
- any Current Member may append a Post that `disputes` an earlier Post;
- original and linked Posts remain inspectable with their exact attribution and bytes;
- derived rendering may label superseded/disputed state but never silently choose truth or consensus;
- for a new append, target validation occurs inside the same lock/critical section as replay, capacity, sequence, and publish; target must be a healthy canonical earlier Post in the same active-layout Board;
- missing/foreign/self/future targets, unknown relation/fields, multiple links, and same-author violation return bounded link errors before sequence/time allocation;
- a malformed/tampered target is quarantined and the new append fails `link-target-invalid`; it is never treated as a valid target or silently unlinked;
- links must point backward by sequence, so retry/restart cannot create a cycle;
- an exact replay returns its already-validated original Post even if the historical link target was later quarantined; replay never allocates or revalidates the current target snapshot.

There is no edit/delete/moderation operation in v1. Security recovery for accidentally persisted credentials requires an explicit trusted project maintenance operation outside the Board Member API; it must not masquerade as ordinary Post editing.

## Storage and durability

The Board lives once beside the active trusted Crew manifest:

```text
.pi/bebop/
  crew.json
  board/
    .lock
    posts/<post-id>.json
    quarantine/
```

The compatibility layout is `.pi/crew/board/`. Bebop opens only the layout selected by active Membership. It never mirrors, merges, or falls back between layouts and never creates a per-Member Board copy.

A missing Board read is read-only and returns the canonical empty result; it creates no directory, lock, file, or cursor. First append validates the trusted contained path, creates the Board/posts directories idempotently, then acquires the lock. Join/restore/rejoin alone performs no Board filesystem IO.

### Lock and critical section

- `.lock` is created with exclusive-create semantics and canonical `{ "version":1,"ownerHash":"<sha256>","createdAt":<utc-ms> }` bytes. `ownerHash` hashes an injected 1–128-character operation-local owner nonce; raw nonce/PID/session/path is not persisted.
- Acquisition has one injected-monotonic absolute deadline of 2,000 ms and bounded 25 ms retry intervals. Timeout/malformed lock returns `lock-conflict` with recovery guidance.
- V1 never deletes/steals a lock based on wall-clock age, PID, or guessed liveness because that can corrupt a live writer. A crash-stale lock requires an explicit trusted maintenance action after the operator establishes no process owns it; automatic stale-lock recovery is deferred.
- Release re-reads ownerHash and unlinks only the caller's exact lock. Every success/error/abort path attempts own-lock release once and never removes a foreign lock.
- Replay/conflict lookup, invalid-record quarantine, healthy capacity/count, link-target validation, maximum-sequence derivation, sequence/time allocation, temp write, exclusive publish, and result snapshot share this one critical section.
- Sequence is `max(healthy canonical sequence)+1`; overflow beyond the safe-integer bound rejects. Only healthy canonical Posts count toward the 4,096 capacity.

### Temp, publish, and quarantine

- Temp names are `.tmp-<ownerHash>-<post-id>` within the contained Board. Failure cleans only the current owner's temp. After explicit stale-lock recovery, the next valid lock owner quarantines foreign temp files; it never deletes an active owner's state.
- Publish uses an atomic **no-replace** same-filesystem operation. Target collision re-reads the derived ID and returns exact replay or idempotency conflict; it never overwrites bytes. Unsupported no-replace semantics fail before claiming persistence.
- Invalid post files are quarantined while holding the Board lock. Target name is `<sha256(source-basename)>.invalid.json`; collision uses the smallest available deterministic `-N` suffix. Atomic rename into `quarantine/` occurs before healthy results/capacity are computed.
- Malformed, oversized, unsupported-version, wrong-ID/fingerprint/sequence-shape, foreign, or non-canonical records are invalid. A linked target found invalid is quarantined and causes `link-target-invalid` for that new append.
- Quarantine failure aborts the entire read/append with `quarantine-failed`; no partial healthy result or new Post is reported. Quarantines already completed remain durable, so retry continues from the changed store honestly.
- Board scans accept at most 8,192 directory entries per `posts/` or `quarantine/` directory; overflow returns `directory-capacity-exceeded` before reading unbounded content. File size is checked before full read.
- A successful read may therefore mutate only invalid filesystem artifacts through quarantine. It never mutates a healthy Post or per-Member read state. Repeated byte-stability applies to an unchanged post/quarantine snapshot; a quarantine repair is an explicit state change reported by that read.
- All lock, directory, stat/read, cleanup, no-replace publish, and quarantine dependencies are injected and bounded; failures never fabricate append/read success.

`board/` is runtime-owned and Git-ignored like `inbox/`; manifest and instruction configuration remain tracked. Storage is shared only by Crew processes using the same project filesystem. V1 provides no network replication, cross-machine synchronization, cloud service, or global/cross-project Board.

## Discoverability without delivery

Every Current Member learns the affordance, but no Crew Post is pushed automatically.

Joined/restored/rejoined agent context contains exactly one stable line:

```text
Crew Board: use read_crew_board to inspect shared Posts and leave_crew_post to add one. Posts are not delivered automatically.
```

Tool descriptions teach voluntary use:

- read when starting unfamiliar work or seeking shared project context;
- append when a reusable tip, kudos, feedback, warning, or note should outlive the current Pi session.

Successful human `/crew join` output and `/crew` usage/help name `/crew board` and `/crew post` once. Join, restore, help, and prompt construction never read the Board, include a count/body/reference/cursor, create a notification, or start a provider turn.

## Promotion and Retrospectives

A useful Post may be deliberately promoted through the destination's own process:

- documentation or AGENTS.md through an ordinary reviewed project change;
- a task/plan through its task lifecycle;
- a Crew Agreement through proposal, candidate revision, and trusted activation;
- Retrospective evidence through a later bounded collector with provenance.

Append itself performs none of those transitions. A Post, kind, link, repeated mention, or Member identity grants no promotion or activation authority. Crew Board collection for Retrospectives is deferred from v1.

## Failure and restart semantics

| Situation                              | Required result                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Unjoined/inactive/removed Member       | Reject before Board IO                                                           |
| Different Roles append/read            | Identical capability and limits                                                  |
| Missing Board directory                | Explicit read returns canonical empty without IO creation; append creates lazily |
| Invalid/sensitive message or reference | Reject before lock/publication; raw input never enters ID/log/error/storage      |
| Duplicate exact operation              | Return original Post unchanged without allocation or link revalidation           |
| Conflicting replay                     | Stable conflict; original remains unchanged                                      |
| Concurrent writers                     | Serialize publication; unique stable sequence and no accepted loss               |
| Crash before/after no-replace publish  | Zero or one complete Post; retry is idempotent                                   |
| Capacity reached                       | Reject append; never evict history                                               |
| Malformed/oversized/tampered file      | Quarantine under lock; continue healthy bounded read and report bounded count    |
| Invalid/quarantined link target        | Quarantine when applicable; reject new append without allocation                 |
| Stale/malformed lock                   | Bounded `lock-conflict`; no age/PID stealing; explicit trusted maintenance       |
| Quarantine/lock/read/write failure     | Explicit bounded error; never fabricate success                                  |
| Leave/restart/rejoin                   | Posts remain; rejoined Member sees same Board                                    |
| Role/manifest change                   | Prior attribution remains; new append uses current Membership snapshot           |
| Both supported layouts exist           | Active Membership layout only; no merge/fallback                                 |
| Newer append during pagination         | Existing cursor continues older scan boundary; refresh omits cursor              |
| Cursor filter changes                  | Reject `cursor-filter-mismatch`; limit may change                                |
| Offline Member                         | No delivery attempt and no readership claim                                      |

## Explicitly deferred

- direct recipients, notifying mentions, guaranteed delivery, replies, or threads;
- private Posts, ACLs, Role permissions, owners, moderators, or read/write tiers;
- reactions, likes, numeric/star ratings, reputation, ranking, sentiment, productivity, or performance scoring;
- task assignment/status, approvals, voting, consensus, decisions, or instruction/Agreement authority;
- automatic Board reads, prompt content injection, polling, unread counts, read receipts, notifications, or periodic summaries;
- automatic truth checking, conflict resolution, expiry, eviction, deletion, promotion, or Retrospective collection;
- arbitrary attachments, unbounded search/history, external anonymous posting, global boards, Git/network/cloud synchronization.

## Planned implementation slices

- TASK-0123 — closed Crew Post domain and trusted shared Board storage;
- TASK-0124 — shared application operations and agent tools;
- TASK-0125 — human `/crew board` and `/crew post` adapters;
- TASK-0126 — independent lifecycle verification and documentation.
