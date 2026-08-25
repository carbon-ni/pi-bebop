# Membership CLI parity contract

Status: **product contract approved by TASK-0060; implementation belongs to TASK-0061 through TASK-0067**.

Machine-readable decision matrix: [`cli-membership-parity.json`](cli-membership-parity.json).

This contract maps the eight joined-only Bebop tools to deterministic standalone CLI commands. The CLI acts through one already-running joined Pi session. It never loads a crew manifest to invent source identity, never bypasses Pi project trust, and never exposes Pi built-in tools.

## Frozen framework boundary

TASK-0056 selected Commander 15.0.0 for tokenization and deterministic help. Membership commands preserve that boundary:

- Commander parses one isolated leaf command and its metadata.
- Application pre-pass owns duplicate detection and sentinel values.
- Application owns cross-flag/domain validation, source selection, trust, IO, rendering, and exit assignment.
- Usage failures are structured stdout with exit 2; operational failures exit 1; successes and expected outcomes exit 0.
- TOON is default; JSON and text are explicit command-local alternatives.

No membership behavior is implemented by TASK-0060.

## Command hierarchy

| Tool                   | CLI leaf                                  |
| ---------------------- | ----------------------------------------- |
| `send_follow_up`       | `member follow-up <member>`               |
| `redirect_member`      | `member redirect <member>`                |
| `send_to_inbox`        | `member inbox send <member>`              |
| `broadcast_to_crew`    | `crew broadcast`                          |
| `interrupt_member`     | `member interrupt <member>`               |
| `get_member_status`    | `member status <member>`                  |
| `update_member_focus`  | `member focus set` / `member focus clear` |
| `wait_for_member_idle` | `member wait-idle <member>`               |

`member inbox send` names the mutation and reserves `member inbox status|pause|resume|cancel` for possible future local Inbox management. Existing `send` and `crew init` remain separate public commands.

## Source-session selection

Every membership-action leaf accepts:

```text
--session <id|alias>
```

The flag is leaf-command-local: it appears after the selected leaf command and before any `--` positional terminator. It is never accepted at root or group scope.

Resolution is deterministic:

1. A nonblank explicit `--session` wins.
2. An explicit unsafe/unknown value fails; it never falls back.
3. Without the flag, safe exact `PI_SESSION_ID` is used. Environment value is never interpreted as alias.
4. Without either source, return `session-required` and the copyable hint `pi-bebop session list`.
5. Safe explicit ID resolves its control socket; safe explicit alias resolves its alias symlink to exact ID.
6. Session must be reachable, joined, and project-trusted before member action IO.
7. Receiving session derives current membership, identity, manifest, and trust. Request cannot supply any of them.

### Trust boundary

Possession of local filesystem permission to a Pi control socket authorizes invoking that session's RPC surface. This is local control authority, not external authentication. CLI must not weaken socket permissions, report itself as Pi-trusted, accept caller-selected origin, or expose socket/manifest paths in normal action results.

### Stable source errors

| Code                 | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `session-required`   | No explicit source and no safe `PI_SESSION_ID`.                    |
| `invalid-session`    | Selector is blank, oversized, traversal-like, or otherwise unsafe. |
| `unknown-session`    | Safe id/alias does not resolve.                                    |
| `offline-session`    | Resolved source control endpoint is not reachable.                 |
| `not-joined`         | Source Pi exists but has no active crew membership.                |
| `untrusted`          | Source membership project is not trusted.                          |
| `malformed-response` | Source response violates closed result schema.                     |
| `timeout`            | Bounded source action did not answer in its contract deadline.     |
| `aborted`            | Caller cancelled the operation.                                    |
| `transport-error`    | Bounded local transport failed otherwise.                          |

Missing/unknown/offline/unjoined errors point to `pi-bebop session list` and never continue to target member IO.

## Session discovery

```text
pi-bebop session list [--format toon|json|text]
```

`session list` requires no source session and performs no mutation. Default bounded fields are:

```text
sessions[N]{sessionId,aliases,membership}
```

and the top-level result is always `{sessions, total, omitted}`.

`membership` is `joined`, `unjoined`, or `unknown`. Invalid/stale control entries are skipped. A live socket whose bounded status query fails remains visible as `unknown`; it is never guessed joined. Sessions and aliases use deterministic lexical order (safe primary alias then session id, locale-independent). Only safe explicit session-name and branch aliases are reported; aliases that resolve to private/foreign session ids, unsafe slugs, or exceed the per-session cap are excluded and reported as safe slugs only — never raw paths or ids.

Bounds:

- scan at most 256 control-directory entries;
- return at most 100 sessions and 8 safe aliases per session;
- use a 500 ms per-session probe deadline;
- report the `omitted` count (0 when nothing is truncated) whenever the session cap, alias cap, or scan cap cuts results short.

Forbidden output: socket/manifest paths, messages, prompts, model/provider, instructions, tool history, Focus, or session content. Empty state exits 0, returns `omitted: 0`, and explains how to start/join Pi. Control-directory failure exits 1 as `control-store-unavailable`.

## Shared inputs

### Member target

A trimmed UTF-8 label, maximum 256 bytes. Resolve exact configured name first, otherwise unique role. Unknown and ambiguous roles are distinct. Self-target codes remain action-specific (`self-send`, `self-query`, `self-wait`).

### Message input

Message-taking leaves accept exactly one:

```text
--message <text>
--stdin
```

They accept ordered repeatable `--instruction <text>` only where the corresponding tool does.

Validation order is fixed: flag, combination, and limit validation completes before any stdin read; the stdin read is then bounded and cancellable; content validation (empty, NUL, UTF-8 bytes, aggregate) applies after the read and still before any session or target IO. Empty/invalid input is a usage error (exit 2) with no partial side effects.

Limits are the Message Payload contract and are asserted by the schema guard: content at most 1,000,000 UTF-8 bytes, at most 32 instructions, each instruction at most 100,000 bytes and trimmed/NUL-free, aggregate payload at most 1,000,000 bytes. Message text is preserved verbatim (no trim); whitespace-only content counts as empty. Content and every instruction must be NUL-free.

Follow-up and Redirect are accepted-delivery only. There is no CLI `wait_for` flag because Response correlation belongs to the separate Member request workflow (`send_member_request` / `wait_for_request_outcome`). Help must say accepted does not mean replied or completed.

### Focus input

```text
member focus set [--session <id|alias>] [--format toon|json|text] [--] <text>
member focus clear [--session <id|alias>] [--format toon|json|text]
```

Flags precede `--`. Text after it is preserved verbatim, including leading dash. Set requires trimmed single-line NUL-free Focus at most 256 UTF-8 bytes. Clear accepts no text. Clear while already unspecified is an explicit unchanged success.

### Idle timeout

```text
member wait-idle <member> [--timeout <duration>]
```

Use the shared duration parser (`500ms|30s|5m`) but accept only values resolving exactly to 1–600 whole seconds. Default is `5m`; sub-second and non-whole-second values are rejected without rounding.

Three deadlines remain distinct:

- source resolution/connection setup: fixed 5 seconds;
- semantic idle operation: caller `--timeout`;
- client response grace after semantic deadline: fixed 5 seconds.

The source semantic idle timeout wins simultaneous operation/transport expiry. Setup timeout wins only when setup itself never completed.

## Result and delivery matrix

The JSON artifact is normative for full fields and error lists. Startup role selection is a Pi flag (`pi --crew-role <role>`), not a `pi-bebop` leaf; it resolves exact trusted manifest roles and delegates the existing join path. Summary:

- `member follow-up` — success `accepted` with member identity, delivery id, disposition `direct|queued`. Delivery: online normal message; waits behind busy work; accepted never means reply, delivered work, or completion. Cancellation: before dispatch prevents; after acceptance cannot retract; lost ack is outcome-unknown.
- `member redirect` — success `accepted` with member identity, delivery id, disposition `direct|steered`. Delivery: online direction change before the target's next model step; never aborts. Cancellation: after acceptance cannot retract steering.
- `member inbox send` — success `persisted` with member identity, `itemId`, `persisted: true`, hint `sent|skipped`. Delivery: one durable Inbox item whether online or offline; persisted only. Cancellation: no rollback after write; lost ack is `outcome-unknown`, never a safe blind retry.
- `crew broadcast` — success `persisted|partial` with `broadcastId`, summary counts, and per-recipient dispositions; per-recipient failure codes are the store-mapped set (`inbox-full`, `inbox-untrusted-path`, `untrusted-project`, `storage-unavailable`, `storage-failed`, `invalid-payload`, `invalid-item-id`, `aborted`). Delivery: deterministic durable copy for every other member; identical retry reuses ids and reports `already-persisted`. Cancellation: completed writes remain; remaining recipients report `aborted`.
- `member interrupt` — success `accepted` with interrupt id, disposition `direct|interrupt-requested`. Delivery: pending recovery evidence, best-effort abort, priority handoff; no rollback. Cancellation: after evidence cannot remove recovery; ack may be unknown.
- `member status` — success `observed` with the closed online/offline Member Status shape (see discriminated shapes). Delivery: read-only; target offline is a successful unavailable snapshot, never stale Focus. Cancellation: aborts the finite probe/RPC; no state mutation.
- `member focus set|clear` — success `updated|cleared|unchanged` with `focus.state/text/updatedAt`; clear while unspecified is unchanged. Delivery: self-only context-free session entry. Cancellation: after append cannot roll back; status is authoritative after a lost ack.
- `member wait-idle` — success `observed` with discriminated outcome `idle` (disposition `already-idle|became-idle`), `offline`, or `timeout`. Delivery: one-shot event wait, no polling/message; no acknowledgement/completion inference. Cancellation: cleans the subscription once; expected timeout/offline still exit 0.

## Error and exit policy

Every action's closed error vocabulary is `sourceSelection.errors` (shared, inherited) **plus** its `tools[].errors` list; the two are disjoint, and a code appears at most once across the whole artifact. Codes are reconciled with the stable application/domain error unions (see the schema guard); only `offline` (target transport) and `outcome-unknown` (unreconstructable mutation outcome after lost acknowledgement) are CLI-layer codes.

Reconciled action code names: member-targeted commands share `unknown-member`, `ambiguous-member`, and action-specific self codes (`self-send`, `self-query`, `self-wait`, `self-interrupt`); Inbox send uses `ambiguous-role` plus the store-mapped `inbox-full`, `inbox-untrusted-path`, `storage-unavailable`, `storage-failed`; Broadcast adds per-recipient `already-persisted` (disposition, not an error) and the store-mapped recipient failure codes; Interrupt uses the resolution codes (`self-interrupt`, `not-a-member`) plus the flow codes (`already-pending`, `abort-failed`, `no-context`, `handoff-failed`).

- Exit 0: accepted, persisted, observed, updated, cleared, unchanged, target-offline status, idle-wait offline, idle-wait timeout, empty session list.
- Exit 1: operational/action error, partial broadcast, aborted, or outcome unknown.
- Exit 2: command/flag/value/limit/combination usage error.

Ctrl-C cancels pending stdin reads, in-flight RPC, and one-shot waits with
bounded cleanup and the `aborted` code.

TOON and JSON encode the same semantic object. Text is concise human presentation and must not remove distinctions such as accepted versus persisted, partial, offline, timeout, or unknown outcome.

### Discriminated result shapes

Closed result shapes, identical in TOON and JSON:

- Follow-up/Redirect/Interrupt: `status: accepted` plus member identity, delivery/interrupt id, and a closed `disposition` (`direct|queued`, `direct|steered`, `direct|interrupt-requested`).
- Inbox send: `status: persisted` plus member identity, `itemId`, `persisted: true`, and a best-effort `hint` (`sent|skipped`).
- Broadcast: `status: persisted|partial` plus `broadcastId`, `persisted`, `alreadyPersisted`, `failed`, `total`, and per-recipient `{member, role, itemId, disposition: persisted|already-persisted|failed, code}`; per-recipient failure codes come from the store mapping: `inbox-full`, `inbox-untrusted-path`, `untrusted-project`, `storage-unavailable`, `storage-failed`, `invalid-payload`, `invalid-item-id`, `aborted`. Pairing is strict: each failed recipient pairs `disposition: failed` with a stable code; persisted and already-persisted recipients carry no code.
- Status: `status: observed` and a discriminated member object — online: `{presence, activity: idle|busy|compacting, hasPendingMessages, focus: reported|unspecified}`; offline: `{activity: unavailable, hasPendingMessages: unavailable, focus: unavailable}` — plus `observedAt`.
- Focus: `status: updated|cleared|unchanged` plus `focus.state`, `focus.text`, `focus.updatedAt`; clear while unspecified is unchanged.
- Wait-idle: `status: observed` and a discriminated outcome — `idle` (with `disposition: already-idle|became-idle`), `offline`, or `timeout` — plus member identity and `observedAt`; idle-wait offline and timeout still exit 0.

## Cancellation principles

Cancellation is request-scoped and best-effort. It never implies rollback:

- transient read/wait/list operations clean listeners/sockets and mutate nothing;
- live delivery may already have been accepted when acknowledgement is lost;
- durable Inbox/Broadcast writes already completed remain;
- Interrupt recovery evidence already persisted remains reload-safe;
- Focus entry already appended remains authoritative.

When acknowledgement is impossible after a mutation, return bounded `outcome-unknown` where the action cannot be reconstructed safely. Broadcast is the exception: deterministic broadcast and item ids make identical retry safe and report `already-persisted`.

## Pending decisions

`idempotency-conflict` (broadcast) is reserved but its semantics are **pending product wording**. Identical-retry id reuse and `already-persisted` reporting are approved; what happens when a conflicting request claims the same broadcast identity is not yet decided and must not be implemented or asserted until product wording arrives.

## Help and home discovery

Root home remains compact and adds grouped command hints only. Group invocation without a leaf produces local bounded help. Each leaf help includes its source rule, defaults, delivery guarantee, cancellation caveat, exit codes, and 2–3 runnable examples. It never dumps all eight tool descriptions.

`session list` is the recovery hint for source errors. Message help differentiates Follow-up, Redirect, durable Inbox, Broadcast, and Interrupt. Status/Focus/Idle help repeats privacy and no-inference boundaries.
