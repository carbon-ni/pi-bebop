# TASK-0152 evidence record

This record captures current-head evidence for message provenance and timing. It is
not an acceptance or stale-message decision.

## Package inventory

Command:

```sh
npm pack --dry-run --json
```

Observed current package inventory: 86 files; `src/domain/message-age.ts` is
included; language test files are not included. Runtime modules such as
`src/domain/session-id.ts` and `src/infra/socket-endpoint.ts` are package
implementation dependencies, not model-visible header fields.

## Privacy and stale-policy checks

The model renderer strips `kind` and `sentAt` from the canonical body and emits
the typed header plus the compatibility payload body. Callback `replyTo` remains
in that body where callback behavior requires it, but is never displayed in the
TUI header or body renderer. Header tests reject route-like leakage (`sessionId`,
socket, manifest, and private callback values).

Representative checks:

```sh
rg -n 'sessionId|socket|callback|replyTo|manifest|stale|expired|TTL' \
  src/domain/message-age.ts src/domain/message-renderer.ts src/pi/message-renderer.ts
```

The matches are implementation comments, legacy metadata stripping, or hidden
callback fields; no matched value is emitted by the provenance header. Existing
TUI/model tests assert that private callback routes are absent. `stale` is
language for a receiving agent's relevance judgment only: there is no threshold,
classification, expiry, drop, reorder, retry, or automatic response policy.

## Focused acceptance evidence

- `src/cli/member-message.integration.test.ts`: real Unix-wire Follow-up and
  Redirect source-to-target headers at deterministic clocks; malformed timed
  delivery is rejected before target `sendMessage`.
- `src/pi/inbox-lifecycle.integration.test.ts`: hours-old Inbox retry and exact
  Broadcast/external Intake headers with persisted enqueue time.
- `src/pi/message-age-multi-runtime.integration.test.ts`: real source and target
  Unix-socket runtimes combine an immediate transient Follow-up with a delayed
  durable Inbox handoff; both exact headers freeze at the injected delivery
  instant.
- `src/pi/message-renderer.test.ts`: all eight canonical kinds, collapsed and
  expanded models, replay stability, unknown origin, unavailable timing, and
  callback-route privacy.
- `src/application/interrupt-flow.test.ts`: new Interrupt sent time survives
  pending evidence and recovery; injected delivered time is persisted.

## Verification status

Current implementation head at the time of this record is kept in Git history.
The dedicated multi-runtime test must be included in a fresh watcher run before
independent exact-head QA. TASK-0152 remains open.
