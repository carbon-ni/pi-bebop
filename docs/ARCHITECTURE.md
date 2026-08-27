# Architecture

## Crew presence

Presence is identity-based: configured socket paths are canonical identities; names and roles are descriptive claims. `presence.hint` is a best-effort JSON-RPC trigger and never directly changes reducer state. The observer validates exact claims, probes peers with a 500ms bound, and emits reducer effects only from validated observations. `createPresenceLifecycleCoordinator` owns replacement and cleanup ordering; the adapter resolves configured peer targets and isolates individual wire failures. Lifecycle snapshots use ordered member/current metadata plus notifications in a deterministic fingerprint.

`pi-bebop` is an independent Pi TypeScript extension for managing small,
project-local agent crews. It does not depend on `pi-intray` at runtime or
share its socket directory, flags, tools, or custom message type.

## Boundaries

```text
src/domain  <-  src/infra  <-  src/pi / src/tools
```

- `src/domain/` — pure protocol, crew-manifest, response-policy, and parsing
  rules. No Pi runtime or filesystem imports.
- `src/infra/` — filesystem, socket, git, environment, and RPC boundaries.
- `src/pi/` — flags, `/crew` command, renderer, lifecycle hooks, and socket
  runtime composition.
- `src/tools/` — discoverable Pi tool registrations. Bebop registers only
  `send_follow_up`, `redirect_member`, and `send_to_inbox`.
- `src/**/*.test.ts` — deterministic colocated `node:test` coverage.

## Isolation and configuration

Bebop owns these namespaces:

- Runtime Unix sockets: `~/.pi/bebop/<session-id>.sock`
- Runtime aliases: `~/.pi/bebop/<alias>.alias`
- Project crew manifest: `.pi/bebop/crew.json` (canonical)
- Compatibility manifest: `.pi/crew/crew.json` (exact allowlist only)
- Project member endpoints: `.pi/bebop/sockets/<member>.sock` or `.pi/crew/sockets/<member>.sock`
- Inbound custom messages: `bebop-session-message`

The manifest is trusted only when its resolved location is exactly one of the
project-local `.pi/bebop/crew.json` or `.pi/crew/crew.json` paths. A socket's
layout selects its matching manifest deterministically; there is no fallback or
merge, and arbitrary `.pi/<name>/crew.json` paths remain rejected. It maps unique
names and roles to relative paths beneath `sockets/`; endpoint symlinks are
transport details, not identity.

## Socket protocol

The Unix socket uses one JSON-RPC 2.0 value per newline. Production accepts only
these methods: `session.status`, `message.send`, `session.get_message`,
`session.clear`, `session.abort`, `event.subscribe`, `presence.hint`,
`member.status`, and `member.idle_wait`; turn completion is the
`session.turn_end` notification. `member.status` is a strict read-only snapshot
(one bounded member label, no caller-selected fields, no message-content
data); the handler computes activity/pending at request time and responds without
triggering a turn. `member.idle_wait` is a one-shot
idle subscription: registration plus the initial `ctx.isIdle()` snapshot are
atomic, already-idle completes immediately with `idle/already-idle`, and busy
waits complete once from Pi `agent_settled` (never `agent_end`/`turn_end`) as
`idle/became-idle`; the terminal event carries only name/role,
outcome/disposition, and the observation timestamp. Request IDs are correlated
and responses have
exactly one result or standard error. Schema validation happens before handler
side effects, and clients fail immediately on malformed, mismatched, duplicate,
or wrong-subscription peer output. The migration intentionally breaks the
legacy `{ type, ... }` envelope; JSON-RPC does not add authentication.

## Runtime lifecycle

- `pi --crew` starts Bebop's socket server.
- `pi --crew-role <role>` starts the server and adopts the exact role's
  manifest-configured member from the trusted local project.
- `pi --crew-socket <path>` starts the server and adopts the configured member
  represented by that endpoint; it remains the explicit cross-worktree escape hatch.
- `/crew join <socket>` starts the server if needed, validates project trust,
  then claims the member endpoint.
- `/crew leave` releases only the current endpoint.
- `/crew stop` releases membership before stopping Bebop's server.
- `/crew members` renders the current membership's manifest roster directly, without
  an `[intray-status]` or other custom header. It shows manifest path/count and
  manifest-order rows containing configured member name, role, absolute project
  socket path, and exactly `current`, `online`, or `offline`:

    ```text
    Crew: /project/.pi/bebop/crew.json
    Members (3):
    - lead (lead) — current — /project/.pi/bebop/sockets/lead.sock
    - Bob (dev) — online — /project/.pi/bebop/sockets/Bob.sock
    - Kelly (qa) — offline — /project/.pi/bebop/sockets/Kelly.sock
    ```

    Current identity is matched from membership without probing; non-current
    endpoints are independently finite-time probed and failures render offline.
    Global UUID destinations, generic aliases, and instructions are not exposed.
    When unjoined it returns exactly `Crew not joined. Use /crew join <socket>.`;
    it does not read a manifest or discover sessions, and does not trigger an
    agent turn. Both `.pi/bebop` and `.pi/crew` use the same formatter.

- Reload/resume restores active membership after revalidation. Shutdown always
  attempts endpoint release before server cleanup.
- Common instructions are optional version 2 manifest configuration via one
  relative `commonInstructionsFile`; the trusted loader snapshots that file for
  every member before claim. Role instructions support one source per member:
  inline `instructions` or a relative `instructionsFile`. Common and role files
  are independently loaded as strict UTF-8 snapshots (maximum 64 KiB), only
  beneath the active layout's `instructions/` directory after real-path checks.
  Blank, NUL, directory, unreadable, invalid, oversized, or escaping files
  reject the join atomically. Files are not watched; leave/rejoin refreshes the
  paired snapshot. `AGENTS.md` is project-wide guidance, `common.md` is shared
  crew guidance, and role files define member responsibilities.

Server status is `stopped`, `online`, or `joined`. A session publishes its
socket and up to two aliases (session name and project/branch alias) under
Bebop's own runtime directory. Extension installation and a server in `online`
state keep crew tools registered but inactive and add no agent prompt context;
only `joined` activates the five crew tools and injects identity, roster, and
current role instructions. Crew management output is TUI-only while unjoined.

## Crew delivery

`send_follow_up` and `redirect_member` are thin intent adapters over
`src/application/member-message.ts`. Follow-up is the normal/default path and
maps to queued delivery while busy; redirect is opt-in and maps to steering
active work. Both return schema-validated `deliveryId`/disposition
acknowledgements without subscribing to global `turn_end`. Response waiting is
rejected because Pi lifecycle events cannot prove delivery-level correlation.
All sends share the strict domain `MessagePayload` (`content`, ordered
`instructions`, claimed `origin`, and optional callback-only `replyTo`). The wire
uses `delivery`; legacy `mode` is not a wire field. Crew origin is derived at
execute time from current membership, while direct `--from` attribution is
explicitly external and unverified. `replyTo` is independent of origin and is
omitted for synchronous/no-reply sends. The recipient receives canonical JSON
context plus typed `details.messagePayload`; the UI displays origin,
instructions, and content but hides reply routing.

The tools are active only while joined to a crew. A live endpoint owned by
another session is never overwritten; stale endpoints can be reclaimed.

### Member interrupt

`interrupt_member` is a target-owned live recovery operation. The target's
`message.interrupt` handler validates the request, persists `interrupt.pending`
evidence, requests an abort only when busy, then sends one recovery steer and
persists handed-off evidence. On reload, pending evidence without hand-off is
retried before normal continuation. Pi gives recovery steer precedence over older
follow-ups, but abort is best-effort and never rolls back prior side effects.

### Durable member inbox

The inbox is a small, transport-only boundary between durable storage and
existing Pi follow-up delivery. It deliberately carries no workflow semantics.

- **Storage** (`src/infra/member-inbox-store.ts`): one versioned item file per
  member beneath `.pi/bebop/inbox/<memberKey>/`, manifest-adjacent and
  isolated by a hash of the canonical member socket path. Enqueue takes an
  exclusive per-member lock, writes a temp file, then atomically renames, so a
  crash never publishes partial JSON. Malformed, oversized, or foreign records
  are quarantined so one bad file cannot block the healthy queue. Reads and
  writes are bounded and reject untrusted layouts, symlink escapes, traversal
  ids, full inboxes, and unsafe member paths.
- **Bridge** (`src/application/inbox-bridge.ts`): trigger-driven only (no
  scheduler, no idle probing). Each trigger may offer the oldest pending item
  as one normal follow-up; offers and cancels are serialized so concurrent
  triggers (hint, turn end, restore) never duplicate the same item. Removal is
  evidence-gated: an item leaves storage only after durable recipient session
  evidence contains its stable id, and restart reconciles storage against that
  evidence to close the crash window. Pause stops automatic offering without
  deleting items; cancel removes only pending items and is idempotent. Only
  the current endpoint owner consumes its queue; role switch, leave, stop, and
  shutdown invalidate in-flight attempts.
- **Session adapter** (`src/pi/inbox-bridge-runtime.ts`): hands the item to Pi
  as a typed `bebop-session-message` follow-up whose `details` carry both the
  original `messagePayload` and `inbox.itemId`; the item id is the durable
  evidence reconciled after restart. Automatic offering state persists as an
  `intray-inbox-offering` session entry.
- **Honest language**: `/crew inbox` and delivery acknowledgements distinguish
  _persisted_ (durably stored), _pending_ (stored, not yet handed over), and
  _handed-to-session_ (offered as a follow-up). Nothing claims task
  completion, a response, Git, review, or exactly-once execution. `origin`
  remains claimed attribution, never authentication.

Bebop intentionally does **not** register generic session discovery or direct
session-control tools. Those capabilities are outside crew management.

### Crew Intake (defined)

Crew Intake is the public one-way boundary for messages crossing from an
external actor into the crew; Inbox remains its durable delivery dependency,
not the same concept. The manifest optionally selects **exactly one crew
contact by member name** via `intake.contact`; absent contact means external
intake is disabled (`external-intake-disabled`) — there is never a fallback to
lead, product owner, first, or online member, and roles never resolve a
contact. The contact is responsible only for triage: ignore malformed or
unwanted content, clarify through the external channel when available, or
forward internally with follow-up/inbox; redirect remains exceptional.

- **Origin is claimed and unverified.** The external label comes from the
  caller; contact identity and inbox location come only from the validated
  manifest.
- **One-way acknowledgement.** Persistence acknowledgement carries the item id
  and `persisted` only — no reply route, no promised response. Intake does not
  classify content, select an internal worker, or infer that a message became
  accepted software work.
- **Trust boundary.** Pi surfaces require project trust. The standalone CLI
  (adapter, TASK-0041) treats an explicitly supplied exact-layout manifest
  plus filesystem permissions as caller consent and never claims Pi trust.
- The message is persisted to the contact's inbox (TASK-0035 store) and may
  arrive while the contact is offline.

### Crew Broadcast (tool)

Crew Broadcast is the internal, durable, non-interrupting fan-out initiated
by a current joined member: the same structured message is persisted to every
other member configured by the current trusted manifest, in manifest order,
regardless of presence. Each recipient later receives its own Inbox item
through the normal Follow-up handoff (TASK-0037 bridge). The `broadcast_to_crew`
tool (TASK-0043) exposes the operation to joined members; the domain contract
defined in TASK-0042 remains authoritative.

- **Internal and joined only.** The initiator must resolve to a configured
  manifest member; unjoined or external callers are rejected before
  persistence. Joined-ness is enforced by the application layer (tool), while
  the domain validates sender identity and derives origin. External actors use
  Crew Intake, a separate boundary, and never broadcast directly.
- **Self exclusion by canonical identity.** Recipients are the manifest
  snapshot in manifest order excluding the sender by exact canonical member
  name — never by name/role heuristics. Presence never changes recipients or
  order.
- **Derived origin.** Every recipient payload carries the initiator's crew
  origin derived from the validated manifest member, never from caller-claimed
  input.
- **Non-interrupting delivery.** Broadcast always persists through each
  recipient's Inbox as a normal Follow-up; it can never steer or redirect
  active work.
- **Idempotent retry.** A stable broadcast id plus deterministic per-recipient
  item ids (broadcast id + recipient canonical name only, independent of
  inbox sequence) let a retry fill missing recipients without duplicating
  successful copies. TASK-0043 wiring must persist copies under these ids and
  treat a matching id as already-persisted.
- **Disposition contract.** The outcome reports persisted, already-persisted,
  and failed for every target. Partial success is never presented as total
  success — callers must observe the failed count. One recipient failure or a
  full inbox does not corrupt other recipients and never silently drops a
  failed target.
- **No-recipient no-IO.** When self exclusion empties the recipient set, the
  contract returns an explicit no-recipients outcome and performs no storage
  IO.

Crew Broadcast is not Crew Intake (external one-way boundary), not a shared
inbox or group turn (per-recipient independent copies), and not redirect-all.

## Quality gates

- `npm run format:check` — Prettier check
- `npm run lint` — TypeScript check
- `npm test` — deterministic test suite (builds artifacts first)
- `npm run test:coverage` — coverage gate
- `make all` — pre-push/CI gate

Commit subjects follow `<type>: <summary>` or `<type>(<scope>): <summary>`;
allowed types are `feat`, `fix`, `docs`, `test`, `chore`, and `refactor`.

### Release verification

`make package-verify` (alias `npm run verify:package`) installs a pinned
consumer dependency set and may require network or a warm npm cache, so it is
deliberately separate from quick tests (which pack/extract locally and run the
bundled CLI with no registry IO). `npm pack` produces the installable
`pi-bebop-<version>.tgz`; the packaged `node_modules/.bin/pi-bebop` runs the
same `dist/cli/main.js` the test suite executes directly. Publication to npm is
never assumed: a documented install must be verifiable locally, and `npm view
pi-bebop` must succeed for any claimed published version.
