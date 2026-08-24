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

`membership` is `joined`, `unjoined`, or `unknown`. Invalid/stale control entries are skipped. A live socket whose bounded status query fails remains visible as `unknown`; it is never guessed joined. Sessions and aliases use deterministic lexical order.

Bounds:

- scan at most 256 control-directory entries;
- return at most 100 sessions and 8 safe aliases per session;
- use a 500 ms per-session probe deadline;
- report omitted count when truncated.

Forbidden output: socket/manifest paths, messages, prompts, model/provider, instructions, tool history, Focus, or session content. Empty state exits 0 and explains how to start/join Pi. Control-directory failure exits 1 as `control-store-unavailable`.

## Shared inputs

### Member target

A trimmed UTF-8 label, maximum 256 bytes. Resolve exact configured name first, otherwise unique role. Unknown and ambiguous roles are distinct. Self-target codes remain action-specific (`self-send`, `self-query`, `self-wait`).

### Message input

Message-taking leaves accept exactly one:

```text
--message <text>
--stdin
```

They accept ordered repeatable `--instruction <text>` only where the corresponding tool does. Limits remain the Message Payload contract: content at most 1,000,000 UTF-8 bytes, at most 32 instructions, each at most 100,000 bytes, and aggregate payload at most 1,000,000 bytes. Empty/invalid input fails locally before stdin/session/target IO.

Follow-up and Redirect are accepted-delivery only. There is no CLI `wait_for` flag because Pi cannot prove delivery-level response correlation. Help must say accepted does not mean replied or completed.

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

The JSON artifact is normative for full fields and error lists. Summary:

| CLI                 | Success/expected result                                        | Delivery meaning                                                                  | Cancellation boundary                                                        |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `member follow-up`  | `accepted`; member, delivery id, `direct                       | queued`                                                                           | Online normal message; waits behind busy work. No reply/completion claim.    | Before dispatch prevents; after acceptance cannot retract; lost ack is unknown. |
| `member redirect`   | `accepted`; member, delivery id, `direct                       | steered`                                                                          | Online direction change before next model step; no abort.                    | After acceptance cannot retract steering.                                       |
| `member inbox send` | `persisted`; member, item id, hint sent/skipped                | One durable Inbox item, online or offline; persisted only.                        | No rollback after write; lost ack is outcome unknown, not safe blind retry.  |
| `crew broadcast`    | `persisted                                                     | partial`; broadcast id, summary, recipient dispositions                           | Deterministic durable copy for every other member; idempotent retry.         | Completed writes remain; same request reuses ids; remaining may be aborted.     |
| `member interrupt`  | `accepted`; interrupt id, `direct                              | interrupt-requested`                                                              | Pending recovery evidence, best-effort abort, priority handoff; no rollback. | After evidence, cancellation cannot remove recovery; ack may be unknown.        |
| `member status`     | `observed`; closed online/offline Member Status                | Read-only. Target offline is successful unavailable snapshot, never stale Focus.  | Abort finite probe/RPC; no state mutation.                                   |
| `member focus set   | clear`                                                         | `updated                                                                          | cleared                                                                      | unchanged`; Focus state                                                         | Self-only context-free session entry; no target/network action. | After append cannot roll back; status is authoritative after lost ack. |
| `member wait-idle`  | `observed`; idle/offline/timeout and optional idle disposition | One-shot event wait, no polling/message; no acknowledgement/completion inference. | Abort cleans subscription once; expected timeout/offline still exit 0.       |

## Error and exit policy

Every action inherits source errors and adds only errors listed in `cli-membership-parity.json`.

- Exit 0: accepted, persisted, observed, updated, cleared, unchanged, target-offline status, idle-wait offline, idle-wait timeout, empty session list.
- Exit 1: operational/action error, partial broadcast, aborted, or outcome unknown.
- Exit 2: command/flag/value/limit/combination usage error.

TOON and JSON encode the same semantic object. Text is concise human presentation and must not remove distinctions such as accepted versus persisted, partial, offline, timeout, or unknown outcome.

## Cancellation principles

Cancellation is request-scoped and best-effort. It never implies rollback:

- transient read/wait/list operations clean listeners/sockets and mutate nothing;
- live delivery may already have been accepted when acknowledgement is lost;
- durable Inbox/Broadcast writes already completed remain;
- Interrupt recovery evidence already persisted remains reload-safe;
- Focus entry already appended remains authoritative.

When acknowledgement is impossible after a mutation, return bounded `outcome-unknown` where the action cannot be reconstructed safely. Broadcast is the exception: deterministic broadcast and item ids make identical retry safe and report `already-persisted`.

## Help and home discovery

Root home remains compact and adds grouped command hints only. Group invocation without a leaf produces local bounded help. Each leaf help includes its source rule, defaults, delivery guarantee, cancellation caveat, exit codes, and 2–3 runnable examples. It never dumps all eight tool descriptions.

`session list` is the recovery hint for source errors. Message help differentiates Follow-up, Redirect, durable Inbox, Broadcast, and Interrupt. Status/Focus/Idle help repeats privacy and no-inference boundaries.
