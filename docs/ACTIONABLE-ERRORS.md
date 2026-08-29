# Actionable Errors

Status: **product contract defined; implementation pending under TASK-0088**.

Use the [STE100 profile](STYLE.md) when you edit this reference. Keep error codes, schemas, and fixed text exact.

## Problem

A technical symptom does not help a person or agent recover. Each Pi Bebop failure must name the failed operation. It must give a safe reason, location, and next action.

The result must stay deterministic across text, TOON, JSON, the Pi TUI, and tool results. It must not expose secrets or implementation details.

## Canonical term

An **Actionable Error** is one bounded Pi Bebop-owned failure presentation with a stable code, named user operation, safe reason/location, and at least one concrete recovery or evidence-collection step. It is presentation data, not a replacement for domain errors and not proof that recovery will succeed.

## Finite v1 inventory

### Baseline and inclusion rule

The v1 migration inventory is frozen at source commit `64bd150`. A production surface is in scope when Pi Bebop controls the error wording or structured result at one of these boundaries:

1. a registered standalone CLI leaf returns `CliResult.ok=false` or parsing becomes a usage result;
2. a registered Pi tool `execute` returns `isError:true`;
3. a registered Pi command or startup/lifecycle hook calls Pi UI notification, appends a failure entry, or writes a Pi Bebop failure to console fallback;
4. the executable composition root catches an otherwise unhandled Pi Bebop failure;
5. an internal domain/application/infra/transport error is copied or mapped by one of boundaries 1–4.

Internal errors that never cross a boundary are not separate presentation surfaces. RPC responses are carriers: they are covered where a CLI/tool/Pi adapter renders them. Success, help, progress, and ordinary informational warnings are not errors; a partial-success warning is in scope when it describes a failed sub-operation and recovery.

### Frozen surface groups

| ID             | Public surface                                        | Frozen adapters/operations                                                                                                                                                                                                                                       | Presenter boundary                                                                       |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CLI-ROOT`     | `pi-bebop` parser/process                             | `src/cli/run.ts`, `src/cli/errors.ts`, `src/cli/output.ts`, `src/cli/main.ts`                                                                                                                                                                                    | one `CliOutcome` write; exit `2` usage, `1` operational                                  |
| `CLI-LEAF`     | 11 command leaves plus no-argument home               | `send`; `crew init`; `crew roles`; `member status`; `member wait-idle`; `session list`; `member follow-up`; `member redirect`; `member interrupt`; `member inbox send`; `crew broadcast`; registry home                                                          | leaf returns format-independent `CliResult`; home has no expected operational-error path |
| `TOOL`         | 12 registered agent tools                             | `send_follow_up`, `redirect_member`, `send_to_inbox`, `broadcast_to_crew`, `interrupt_member`, `get_member_status`, `wait_for_member_idle`, `send_member_request`, `respond_to_member_request`, `wait_for_request_outcome`, `leave_crew_post`, `read_crew_board` | tool content plus additive structured details                                            |
| `PI-COMMAND`   | `/crew` command family                                | top-level `join`, `leave`, `members`, `status`, `board`, `post`, `stop`, `agreements`, and `inbox`; `agreements` has `activate`; `inbox` has `status`, `cancel`, `pause`, and `resume`; source is `src/pi/control-commands.ts`                                   | bounded TUI notification/custom entry only                                               |
| `PI-STARTUP`   | startup flags and one-shot send                       | `--crew-role`, `--crew-socket`, persisted Membership restore, `--control-session`/startup-send flags in `src/pi/session-start.ts` and `src/pi/startup-send.ts`                                                                                                   | Pi UI when present; sanitized console fallback otherwise                                 |
| `PI-LIFECYCLE` | extension lifecycle                                   | presence setup/refresh failure and shutdown/release/cleanup failure in `src/extension.ts`                                                                                                                                                                        | Pi UI or sanitized console fallback                                                      |
| `UPSTREAM`     | configuration/storage/transport causes rendered above | Crew manifest/Intake/Membership, Inbox/Broadcast, Crew Agreements/Retrospective, Crew Board, crew-init/template, endpoint/RPC/protocol, filesystem/lock/capacity                                                                                                 | preserve structured source code; presenter supplies operation/recovery and safe fields   |

At the baseline there are 12 CLI registry leaves (11 explicit commands plus home), 12 registered tools across the tool modules, one `/crew` family with nine top-level actions, two startup adapter modules, and extension lifecycle fallback. These named sets—not a count of string literals—are the finite migration unit.

### Completion and future-growth rule

TASK-0088 is complete only when every frozen boundary either:

- constructs the shared Actionable Error presentation and has representative happy/unhappy tests; or
- is recorded in a reviewed exemption table with owner, reason, and external component that owns the wording.

A source/AST guard must fail when a later registered CLI leaf/tool/Pi command/hook adds a direct error render outside the shared presenter or an explicit exemption. New domain error codes do not require inventory edits until a user-facing adapter exposes them; then its presenter mapping/test is mandatory in the same change.

### Explicit v1 exclusions

- Pi/TypeBox tool-parameter validation text produced before Pi Bebop's `execute` callback;
- Node.js, Commander, Git, npm, operating-system, and Pi host wording that never reaches users through a Pi Bebop-owned render path;
- stack traces/debug logs enabled by an explicit future diagnostic mode;
- errors from other extensions such as pi-intray;
- hidden model/provider errors that Pi owns and Pi Bebop cannot contextualize.

Commander failures that Pi Bebop already catches and maps to `UsageError` are in scope. Raw dependency messages become in scope the moment a Pi Bebop boundary interpolates them.

## Format-independent presentation model

Domain/application/infra errors keep structured codes and machine-oriented details independent of UI wording. A boundary maps them to one closed v1 presentation:

```ts
interface ActionableError {
	code: string;
	operation: string;
	message: string;
	location?: {
		kind:
			| "command"
			| "flag"
			| "argument"
			| "config-field"
			| "project-path"
			| "member"
			| "post-id"
			| "cursor"
			| "transport";
		name: string;
		value?: string;
	};
	recovery: string[];
	validChoices?: string[];
	validChoicesTruncated?: boolean;
	omittedChoiceCount?: number;
}
```

### String normalization and field bounds

Every retained source string is valid Unicode, normalized to NFC, trimmed, single-line, and contains no NUL, C0/C1 control, unpaired surrogate, or user-supplied reserved marker `[REDACTED:credential]`/`[REDACTED:secret]`. Only the canonical redactor may generate those markers. Bounds are UTF-8 bytes after normalization/redaction:

| Field                               | Grammar/bound                                                            |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `code`                              | `^[a-z0-9][a-z0-9-]{0,63}$`; known source code or `unexpected-failure`   |
| `operation`                         | presenter-registry constant; 1–96 bytes                                  |
| safe reason used to build `message` | presenter template; 1–240 bytes after safe substitutions                 |
| `message`                           | derived only; 1–1,024 bytes                                              |
| `location.name`                     | presenter-registry constant or validated field/flag grammar; 1–96 bytes  |
| `location.value`                    | optional field-policy output; 1–384 bytes                                |
| each `recovery` item                | presenter template; 1–256 bytes; 1–3 items and at most 768 bytes total   |
| each `validChoices` item            | field-policy output; 1–256 bytes; at most 32 items and 1,024 bytes total |
| compatibility CLI `target`          | same policy as `location.value`; 0–384 bytes                             |

A registry constant/template that violates its bound is a developer contract error and uses the minimal safe fallback; it is never truncated into a new operation or instruction. Unknown causes use `unexpected-failure`; they do not fabricate offline, timeout, permission, malformed, or retryability semantics.

`operation` names the public action, for example `pi-bebop member status`, `Crew startup role join`, `/crew post`, or `read_crew_board`; never an internal class, module, RPC method, store, reducer, or dependency. `location` is included only when it passes its exact field policy. Omission is more honest than an unsafe or guessed location.

### Choice and overflow algorithm

1. Normalize and apply the per-field safety policy before recording any presentation value.
2. For choices, preserve authoritative declared/manifest order, remove exact UTF-8 duplicates after their first occurrence, omit unsafe entries, then retain the longest prefix within 32 entries and 1,024 total bytes. Every unsafe, duplicate, or overflow source entry increments `omittedChoiceCount`.
3. Emit `validChoicesTruncated=true` exactly when `omittedChoiceCount>0`; otherwise omit both truncation fields. When truncated, recovery includes the relevant bounded discovery/help action.
4. Construct `location` and 1–3 recovery items from safe fields/templates.
5. Construct `message` last from the retained operation/reason/location, the first recovery item, and code. Additional recovery remains structured only. The display locator is deterministically UTF-8-truncated on a code-point boundary to 192 bytes with one final `…`; reason and first recovery already use their table bounds. These maxima make the complete message fit 1,024 bytes without dropping operation, reason, known location, recovery, or code.
6. Serialize the fixed-order canonical accounting object below. If it exceeds 4,096 bytes, remove choices from the tail and increment `omittedChoiceCount` until it fits; then, if needed, omit `location.value`, followed by recovery items after the first, recomputing `message` after each affected step.
7. If the model still exceeds 4,096 bytes, use the minimal fallback that preserves the safe original code and operation, gives a generic safe reason plus one evidence recovery, and omits location/choices. Raw values are never truncated directly into fallback text.

The canonical accounting bytes are UTF-8 `JSON.stringify` without BOM/trailing LF over fixed key order `code,operation,message,location,recovery,validChoices,validChoicesTruncated,omittedChoiceCount`; location order is `kind,name,value`. Omitted optionals are absent, never `undefined`. These bytes—not a TypeScript object estimate—must be at most 4,096.

## Canonical text

Text, Pi TUI, and tool content use the exact `message` string:

```text
<Operation> failed: <safe reason>. [Location: <safe locator>.] Next: <recovery 1>. (code: <code>)
```

- One line, one terminal period before `Next`, only the first recovery in text, one final code suffix, and no stack/cause chain. Additional recoveries remain in structured output.
- Usage failures may say `<Operation> rejected input:` instead of `failed:` but retain location, recovery, and code.
- Do not prefix a second technical error code or target outside this message.
- Reasons state observed facts only. `offline` means endpoint reachability failed; `timeout` means the bounded deadline elapsed; neither claims availability, completion, permission, or future outcome.
- Recovery uses an exact command/flag/config field when known. Copyable commands preserve required scope flags and use `<placeholder>` only for information Bebop does not know.
- More than one underlying failure is never collapsed into a false single cause. Report the primary deterministic code and bounded per-item failures through the operation's existing structured partial-result contract.

Examples:

```text
Crew startup role join failed: the configured Intake contact does not name a configured Member. Location: ./.pi/bebop/crew.json#intake.contact="product". Next: set intake.contact to one listed exact Member name or add a matching Member. (code: invalid-intake-contact)

pi-bebop member status rejected input: the supplied target is not a configured Member name or unique Role. Location: argument member="Ghost". Next: run pi-bebop crew roles --format toon and retry with an exact listed value. (code: unknown-member)

Crew Board append failed: the Board could not publish a Post. Next: verify project storage permissions and retry once; if it repeats, report code write-failed, the command name, and the Pi Bebop version. (code: write-failed)
```

## Text, TOON, JSON, and tool envelopes

### Standalone CLI

Existing exit/status semantics remain:

- success/no-op/help: exit `0`;
- operational failure: exit `1`, `status="error"`;
- usage failure: exit `2`, `status="usage"`.

Text stdout is exactly `ActionableError.message` plus the renderer's trailing LF. Expected usage/operational errors write no stderr. Progress/explicit diagnostics remain stderr-only and never enter structured stdout.

JSON and TOON retain the current `CliResult` envelope and add fields inside `error`:

```json
{
	"ok": false,
	"target": "Ghost",
	"status": "error",
	"error": {
		"code": "unknown-member",
		"operation": "pi-bebop member status",
		"message": "pi-bebop member status failed: ... (code: unknown-member)",
		"location": { "kind": "argument", "name": "member", "value": "Ghost" },
		"recovery": ["Run pi-bebop crew roles --format toon and retry with an exact listed value."],
		"validChoices": ["developer", "qa"]
	}
}
```

- `target` remains for compatibility but must itself be a safe locator; otherwise it is `""`. It never carries raw message content, arbitrary absolute paths, sockets, or reply routes.
- JSON uses `JSON.stringify` at the single renderer boundary.
- TOON uses the maintained TOON encoder over the exact same object; no hand-built TOON and no format-specific field drift.
- JSON and TOON must decode to the identical canonical `CliResult` object. `--full` never changes an error object. Field order, arrays, empty/omitted fields, and escaping are deterministic.
- CLI text is at most 1,025 bytes including LF. The complete JSON encoding and complete TOON encoding are each at most 8,192 UTF-8 bytes. The compatibility `target` is sanitized before envelope construction. Fixed field maxima plus the 4,096-byte canonical Actionable Error make the envelope fit; a boundary asserts the bound and uses the minimal safe fallback rather than emitting partial/format-specific fields.
- A catastrophic executable failure before normal dispatch must still use the requested safe output format when it can be determined. If even the renderer cannot run, the final fallback is one sanitized text line with `unexpected-failure`, no raw exception, and exit `1`.

### Pi agent tools

Preserve the current compatibility key `details.error` as the stable code and add the full model without changing `isError`:

```json
{
	"content": [{ "type": "text", "text": "<ActionableError.message>" }],
	"isError": true,
	"details": {
		"error": "unknown-member",
		"actionableError": {
			"code": "unknown-member",
			"operation": "get_member_status",
			"message": "...",
			"recovery": ["..."]
		}
	}
}
```

Tool content and `actionableError.message` are byte-identical. A complete tool error result is at most 8,192 UTF-8 bytes when measured as fixed-order compact JSON for accounting; each rendered text block retains Pi's normal transport encoding. Tool errors do not expose stack/cause or rely on the model to infer recovery from code alone.

### Pi commands, startup, and lifecycle

These human surfaces render `ActionableError.message` through TUI notification/custom entry. TUI text is at most 1,024 bytes; headless text is at most 1,025 bytes including LF. Headless fallback writes the same sanitized line and never interpolates an unknown exception. These surfaces need no synthetic JSON/TOON envelope. Slash-command and startup parsing failures still validate before endpoint/filesystem/provider IO.

## Safe-location and value policy

Safety is allow-list first, redaction second. A generic exception string is never safe merely because a detector found no credential.

### Allowed locators

- canonical command/tool names and declared flags;
- fixed configuration field paths such as `intake.contact`;
- validated exact Member names/Roles and opaque safe IDs when they pass their existing grammar;
- project-relative paths contained by the trusted project root, normalized to POSIX form and prefixed `./`;
- the literal user configuration path `~/.pi/agent/intray.json` without expanding the home directory;
- an absolute path only when it is the exact explicit input of the current invocation, contains no control/sensitive data, is not a runtime/session/socket/temp path, and displaying it is necessary to correct that input. Prefer a project-relative or `~/` form.

For an externally selected Crew layout not safely expressible relative to the current project, render `<crew-root>/.pi/bebop/...` or `<crew-root>/.pi/crew/...` plus the exact field/command—not a runtime-derived absolute root.

### Forbidden output

Never render or place in structured fields by default:

- message bodies, Message instructions, prompts, hidden reasoning, model/provider payloads, or raw Crew Post/Retrospective evidence submitted to the failing operation;
- credentials, authorization headers, URL userinfo, access/API keys, passwords, tokens, private keys, reserved redaction marker spoofing, or secret-bearing query/fragment data;
- `replyTo`, callback routes, global/session IDs, aliases used as reply routes, runtime/member socket paths, lock owners/nonces, operation/tool-call IDs, temp/quarantine filenames, or raw cursors unless the cursor itself is the explicit invalid input and passes its opaque grammar;
- stack traces, exception class/module/function names, Node error cause chains, raw dependency stderr/stdout, environment values, expanded home directory, arbitrary `/tmp` paths, or filesystem contents;
- unsafe absolute paths, traversal, NUL/control/newline data, or unbounded user input.

Known structured errors are mapped field-by-field. Unknown/dependency errors use a generic product reason and evidence recovery; their `.message`, `.stack`, `.cause`, stdout, and stderr are not interpolated.

### Deterministic redaction

The presenter accepts a closed field policy, never an arbitrary string plus an implementation-selected choice. Each source field is exactly one of:

| Field                                                                                             | Source policy                                                         | Sensitive/marker result                                                                                                               |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `code`, `operation`, `location.kind`, `location.name`                                             | static registry or closed grammar                                     | invalid/sensitive registry data -> minimal safe fallback; never redact                                                                |
| safe reason and `recovery[]`                                                                      | static presenter template with validated identifier placeholders only | unsafe placeholder becomes a generic noun; unsafe template -> minimal safe fallback                                                   |
| `location.value` and CLI `target`, exact explicit current-invocation `argument`                   | optional explicit-input context                                       | apply canonical marker redaction; omit entirely on raw marker spoof or remaining unsafe grammar                                       |
| `location.value` for Member/Role/ID/path/cursor/transport and `validChoices[]`                    | optional validated structured value                                   | omit the whole value/choice if detector changes it or raw marker appears; never persist a misleading transformed identity/path/choice |
| `message` and tool/TUI text                                                                       | derived only from retained fields                                     | run detector as an assertion; any new match -> minimal safe fallback                                                                  |
| arbitrary `Error.message`, stack/cause, dependency stdout/stderr, message/instruction/prompt/body | forbidden source                                                      | never passed to redactor or presentation model                                                                                        |

The canonical detector/redactor runs before field byte bounds:

1. Require a Unicode string with no unpaired surrogate or NUL; normalize to NFC and normalize CRLF/CR to LF for detection. A user-supplied literal `[REDACTED:credential]` or `[REDACTED:secret]` is marker spoof and makes the source unsafe; it is never treated as prior redaction evidence.
2. Replace private-key blocks using `/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g` with `[REDACTED:secret]`.
3. Replace URL credentials using `/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi` with `$1[REDACTED:credential]@`.
4. Replace Bearer tokens using `/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~-]{6,}/gi` with `$1[REDACTED:credential]`.
5. Replace sensitive assignments using `/(\b(?:password|passwd|pwd|token|secret|api[_-]key|access[_-]key)\b\s*[:=]\s*)[^\s,;]+/gi` with `$1[REDACTED:credential]`.
6. Replace AWS access-key IDs using `/\bAKIA[A-Z0-9]{16}\b/g` with `[REDACTED:credential]`.
7. Record whether output changed; apply the field's table policy. Then enforce single-line/control/grammar and UTF-8 bounds. A redaction that leaves newline/control or invalid grammar is omitted/fallback, never partially emitted.

Generated classes are canonical order `credential`, then `secret` if future diagnostics need bounded metadata; v1 Actionable Error emits no redaction metadata. Redaction is defense-in-depth, not permission to echo arbitrary exceptions. Construction retains/logs only the resulting safe field, never the raw pre-redaction source.

## Recovery taxonomy

| Error family                       | Required recovery focus                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| usage/invalid input                | name exact command/flag/argument; list bounded choices or exact `--help` command                                                                    |
| configuration/schema               | safe manifest/config path plus exact field; edit field or scaffold/validate configuration                                                           |
| Membership/trust                   | trust project, join/rejoin exact Member, or choose one supported layout; never imply Role authority                                                 |
| target/identity                    | exact configured Member/Role discovery; no guessing/case folding unless operation defines it                                                        |
| offline/reachability               | start/rejoin the exact endpoint or retry after checking Presence; never claim Member availability                                                   |
| timeout/abort                      | state deadline/abort fact; retry or adjust only a documented bound; never claim remote cancellation                                                 |
| conflict/idempotency/capacity/lock | inspect current state, retry same operation only when contract says idempotent, or use explicit trusted maintenance; never overwrite/steal silently |
| filesystem/permission              | verify safe project path ownership, permissions, space, and retry; hide raw OS path/error                                                           |
| malformed/protocol/version         | restart/upgrade compatible participants and report stable code/version; do not expose wire payload                                                  |
| unexpected                         | retry once only when safe; if repeated, report code, public operation, Pi Bebop version, and reproducible non-secret arguments                      |

Recovery advice never promises success, silently mutates configuration, widens authority, converts Follow-up to Redirect, steals locks, deletes state, or asks users to expose secrets.

## Implementation architecture

- Add one pure presentation constructor in domain/application-facing code. It consumes a closed safe descriptor, not arbitrary `Error`.
- Keep mapping from domain/application/infra codes near the public adapter or in operation-specific mapping tables. The shared constructor owns bounds, message grammar, safe locator validation, redaction, and envelopes—not business semantics.
- CLI, tools, and Pi adapters call the same constructor. Renderers only encode text/JSON/TOON/TUI/tool envelope.
- Do not rewrite domain errors into prose-only exceptions. Stable codes and typed details remain testable.
- Validate user input before network/filesystem/subprocess IO as today.

## Deterministic verification matrix

Implementation acceptance requires:

1. inventory snapshot tests for 12 CLI leaves, 12 tools, `/crew` action vocabulary, startup/lifecycle presenter boundaries, plus a guard against new direct renders;
2. text/TOON/JSON semantic parity for one usage and one operational failure from every CLI adapter family, with stdout/stderr and exit-code assertions;
3. every tool error returns `isError:true`, compatibility `details.error`, full `actionableError`, and identical content/message;
4. startup, restore, `/crew`, presence/lifecycle, configuration, filesystem, transport, timeout, abort, conflict/capacity, malformed, and unexpected representative paths;
5. safe choices at 0/1/32/33 entries and byte bounds; authoritative order and truncation metadata;
6. project-relative, explicit safe absolute, external-root placeholder, home-config, traversal, socket, temp, and control-character location cases;
7. credentials/private keys/Bearer/assignment/AWS keys/URL userinfo, message/instruction/reply route/session/socket/stack/cause leakage fixtures;
8. unknown errors never leak raw messages and never become false `offline`/`timeout`/`permission` codes;
9. fixed-order 4,096-byte canonical Actionable Error accounting plus 1,025-byte text and 8,192-byte JSON/TOON/tool envelope bounds; `--full` cannot alter errors; JSON/TOON decode to the same object;
10. existing success bytes, help, statuses, exit codes, domain semantics, delivery intent, persistence, and cleanup remain unchanged.

Coverage must exercise real public adapters for representative failures; tests that only search prose/keywords or mock the shared presenter do not establish compliance.
