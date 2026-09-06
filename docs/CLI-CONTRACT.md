# CLI audience and compatibility contract

Status: normative migration contract for TASK-0165. It defines behavior for TASK-0166–0170; it does not change runtime or wire semantics.

## Principle

Primary audience and its next decision determine a command's default view. Read-only versus mutating does not.

- Agent and automation workflows default to TOON because they need deterministic structured fields.
- Human setup and diagnosis default to concise text.
- Guidance surfaces remain text only.
- JSON stays an explicit interoperability format.

## Current and planned command matrix

Every result-producing leaf supports `--format text|toon|json`. Help and version never wrap prose in structured results.

| Command | Primary audience | Default | Overrides | Next decision |
| --- | --- | --- | --- | --- |
| no arguments (home) | agent | TOON | text, JSON | choose one available command from current state |
| `send` | automation/diagnostic | TOON | text, JSON | confirm Accepted delivery or correct target/options |
| `crew init` | human | text | TOON, JSON | inspect files and start/join a Member |
| `crew roles` | agent | TOON | text, JSON | select exact configured role/Member |
| `crew broadcast` | agent | TOON | text, JSON | inspect per-recipient Accepted/failure outcome |
| `member status` | agent | TOON | text, JSON | decide whether to message, wait, or reassign |
| `member wait-idle` | agent | TOON | text, JSON | continue after exact mechanical outcome |
| `member follow-up` | agent | TOON | text, JSON | confirm Direct/Queued delivery |
| `member redirect` | agent | TOON | text, JSON | confirm active-work redirection |
| `member interrupt` | agent | TOON | text, JSON | confirm recovery handoff or correct failure |
| `member inbox send` | agent | TOON | text, JSON | retain item ID and Persisted state |
| `member request send` | agent | TOON | text, JSON | wait for exactly this outbound request |
| `member request list` | agent | TOON | text, JSON | choose oldest pending inbound/outbound request |
| `member request wait` | agent | TOON | text, JSON | consume one terminal Request outcome |
| `member request respond` | agent | TOON | text, JSON | confirm correlated Response submission |
| `session list` | automation/diagnostic | TOON | text, JSON | select legacy session target or migrate to Crew discovery |
| `guest join` | agent | TOON | text, JSON | retain pending/approved Crew membership state |
| `guest leave` | agent | TOON | text, JSON | confirm exact Crew membership removal/no-op |
| `guest send` | agent | TOON | text, JSON | inspect authorized direct delivery outcome |
| `guest broadcast` | agent | TOON | text, JSON | inspect authorized per-recipient outcomes |
| root/group/leaf `--help` | human/agent guidance | text only | none | copy one valid example |
| `--version` | human/tooling | text only | none | compare installed build/version |
| future `doctor` | human operator | text | TOON, JSON | run one corrected recovery command |
| future `help delivery` | guidance | text only | none | choose required guarantee |
| future `quickstart` | guidance | text only | none | complete discover → Ask → verified Response |

Future name-first `crew list`, `crew status`, `ask`, and Crew history are agent-first TOON with text/JSON overrides unless their own approved contract changes this matrix.

## Command hierarchy

```text
pi-bebop
├── send                         # low-level explicit direct session delivery
├── crew
│   ├── init
│   ├── roles
│   └── broadcast
├── member
│   ├── status
│   ├── wait-idle
│   ├── follow-up
│   ├── redirect
│   ├── interrupt
│   ├── inbox send
│   └── request send|list|wait|respond
├── guest
│   └── join|leave|send|broadcast
└── session list                # legacy transport diagnostics
```

New product workflows belong under `crew`, `member`, or `guest`. `session` and top-level `send` remain compatibility/diagnostic surfaces, not examples for normal Crew coordination.

## Terms at point of use

Help must use these short definitions where a term first affects a decision. Long comparisons belong in the future `help delivery` guide.

- **Joined Member**: current Pi session has claimed one exact manifest Member identity.
- **Source session**: legacy live Pi runtime used to send a command. It is transport, not Crew/Member identity; normal name-first recovery must not ask users to choose one.
- **Socket**: explicit local transport endpoint used only by low-level compatibility commands and diagnostics.
- **Crew Intake**: one-way external → configured Crew contact delivery. It is not Broadcast or Guest membership.
- **Follow-up**: non-interrupting message; if recipient is busy it queues behind active work.
- **Redirect**: message inserted into active work to change the next model step. Legacy `steer` is accepted only where compatibility requires it; product help says Redirect.
- **Response grace**: bounded time after Responder first becomes mechanically idle to submit one correlated Response.
- **Accepted**: live endpoint validated and delivery request acknowledged; not persisted, answered, or completed.
- **Persisted**: durably stored Inbox item; not handed off, read, answered, or completed.
- **Completed**: command lifecycle ended successfully. It says nothing about task completion unless that exact domain operation defines it.
- **Response**: assistant output correlated to exactly one Member Request; ordinary Follow-up or `turn_end` is not a Response.

Help and errors reference runnable CLI commands such as `pi-bebop member request send` and `pi-bebop member request wait`. They never prescribe agent-only tool names such as `send_member_request`.

## Commander ownership boundary

Commander owns:

- root/group/leaf dispatch and longest valid command selection;
- option and positional syntax, defaults, repeatable collection, help, and version;
- unknown option/command and missing required value usage errors;
- standard `-h`, `--help`, and `--` behavior.

Application/domain code owns:

- duration relations and numeric bounds;
- message source, delivery, target, authorization, and UTF-8 limits;
- path/trust/session resolution and all IO;
- protocol payloads, cancellation, ordering, and result data.

One central application-owned Commander option policy rejects repeated scalar flags before any dependency call. `--instruction` remains ordered, repeatable, and bounded. Per-command argv scanners must not return under another name.

## Intentional grammar compatibility

| Surface | Contract |
| --- | --- |
| Successful command semantics | Preserve protocol payloads, ordering, cancellation, authorization, and domain outcomes. |
| Scalar duplicates | Continue to fail with exit 2; Commander last-value-wins is not accepted. |
| Repeatable instructions | Preserve source order and existing bound. |
| Help | Standard `-h`/`--help` at root, group, and leaf; exit 0; exact legacy bytes are not preserved. |
| Option sentinel | Standard `--` ends option parsing. A flag-looking value uses `--flag=--value`. Legacy `--flag -- --value` is retired with a targeted migration hint or leaf help note. |
| Error wording | Domain error codes and meaning stay stable; exact Commander usage prose may change. |
| Exit codes | 0 success/help/idempotent no-op; 1 operational failure; 2 usage failure; 130 caller SIGINT where a blocking command defines it. |
| No arguments | Render compact live home state, not full help. |
| Version | One text line; no structured wrapper. |

Unknown/missing input names the offending value and valid local alternatives. Renamed/retired syntax gives the exact replacement. Validation happens before network, filesystem, socket, or subprocess work.

## Result and rendering boundary

A canonical result is format-independent domain/application data. A command presenter selects a safe semantic view before the single serializer boundary.

- Never serialize internal objects by spreading them blindly.
- Default views contain only fields needed for the next decision.
- Session IDs, socket paths, capabilities, raw Request IDs, stack traces, dependency payloads, and message content are excluded unless the command contract explicitly makes a safe subset public.
- TOON and JSON encode the same normalized value. TOON uses `@toon-format/toon`; no handwritten encoder/parser.
- Text conveys the same outcome in a concise human view, but is not required to round-trip. Bounded canonical presenters select only decision-relevant fields; they never dump a raw result object. Session lists show identity, aliases, membership, totals, and omissions; crew init shows state, target, paths, and the next command; communication receipts show only delivery/request facts.
- Structured errors go to stdout in the selected/default format. Debug/progress diagnostics go to stderr.
- Empty results state query scope and zero count.
- Lists state total separately from shown count and remain deterministic.
- Truncated fields include `truncated`, original size, shown size, and a runnable `--full` hint only when truncation occurred.

A parse failure uses the addressed leaf's default format when that leaf is known. Root dispatch failures use the home/default TOON envelope. Help always remains text.

## Pre-migration representative baseline

These canonical samples were captured before Commander execution migration. Byte counts are UTF-8 and illustrative, not universal savings claims. TOON was decoded with `@toon-format/toon` and deep-equaled the JSON-normalized value for every structured sample.

| Sample | Text | TOON | JSON | TOON round-trip |
| --- | ---: | ---: | ---: | --- |
| four Crew roles | 50 B | 122 B | 186 B | equal |
| queued Accepted Follow-up | 41 B | 123 B | 135 B | equal |
| empty session list | 24 B | 79 B | 89 B | equal |

Earlier current-output characterization also found `crew roles` at 296 B TOON versus 37 B text, `session list --format text` losing rows and returning only `Message completed`, and home at 552 B structured output. These defects justify audience-specific presenters; they are not preserved behavior.

Baseline path coverage required before migration tests:

| Path | Required observation |
| --- | --- |
| Happy | stable semantic fields, selected default, clean stderr |
| Empty | explicit scope and zero count |
| Usage error | offending input, valid alternatives, exit 2, no dependency call |
| Operational error | product error code/message, one safe recovery, exit 1, no raw dependency data |
| Truncated | preview plus original/shown sizes and `--full` escape |

## Known pre-migration implementation gaps

These observations are baseline defects, not claims that current code already satisfies the target contract:

- `guest send` and `guest broadcast` currently reuse a parser helper that wrongly requires a positional Member socket although their Commander builders declare none. TASK-0168 must fix this while migrating Guest grammar and add executable happy-path coverage.
- Leaf `-h`/`--help` is currently disabled or handled by local pre-scanners. TASK-0166–0168 must establish standard Commander help.
- TASK-0170 closes the prior text presentation gap: `session list --format text` now renders bounded session rows and explicit empty/omitted state, while command-specific receipts remain available through the same text override.

## Review gate

Parser implementation may start only after product and lead approve this target matrix and acknowledge the tracked baseline gaps. Any change to audience default, exit code, scalar duplicate policy, sentinel migration, or serialization boundary requires an explicit contract update rather than an incidental parser diff.
