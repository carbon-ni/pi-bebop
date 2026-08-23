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
  `send_follow_up` and `send_immediate`.
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
`session.clear`, `session.abort`, and `event.subscribe`; turn completion is the
`session.turn_end` notification. Request IDs are correlated and responses have
exactly one result or standard error. Schema validation happens before handler
side effects, and clients fail immediately on malformed, mismatched, duplicate,
or wrong-subscription peer output. The migration intentionally breaks the
legacy `{ type, ... }` envelope; JSON-RPC does not add authentication.

## Runtime lifecycle

- `pi --crew` starts Bebop's socket server.
- `pi --crew-socket <path>` starts the server and adopts the configured member
  represented by that endpoint.
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
- Role instructions support one source per member: inline `instructions` or a
  relative `instructionsFile`. File-backed instructions are loaded as a strict
  UTF-8 snapshot during join/restore (maximum 64 KiB), only beneath the active
  layout's `instructions/` directory after real-path checks. Blank, NUL,
  directory, unreadable, invalid, oversized, or escaping files reject the join
  atomically. Files are not watched; leave/rejoin refreshes the snapshot.

Server status is `stopped`, `online`, or `joined`. A session publishes its
socket and up to two aliases (session name and project/branch alias) under
Bebop's own runtime directory.

## Crew delivery

`send_follow_up` and `send_immediate` are thin intent adapters over
`src/application/member-message.ts`. Follow-up is the normal/default path and
maps to queued delivery while busy; immediate is opt-in and maps to steering
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

Bebop intentionally does **not** register generic session discovery or direct
session-control tools. Those capabilities are outside crew management.

## Quality gates

- `npm run format:check` — Prettier check
- `npm run lint` — TypeScript check
- `npm test` — deterministic test suite (builds artifacts first)
- `npm run test:coverage` — coverage gate
- `make all` — pre-push/CI gate

Commit subjects follow `<type>: <summary>` or `<type>(<scope>): <summary>`;
allowed types are `feat`, `fix`, `docs`, `test`, `chore`, and `refactor`.
