# CLI audience and contract

Status: normative v0 contract (TASK-0209). Commander owns discovery, help, and syntax errors; this document pins the audience matrix, stream placement, and exit classes.

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
| no arguments | human guidance | text only | none | Commander root help: pick the next command |
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
| `session capture` | agent | TOON | text, JSON | snapshot joined online Members into a durable Crew Session |
| `session add` | agent | TOON | text, JSON | capture one missing Member into an existing Crew Session |
| `session list` | agent | TOON | text, JSON | list durable Crew Sessions |
| `session show` | agent | TOON | text, JSON | inspect one exact Crew Session and its Member observations |
| `session resolve` | agent | TOON | text, JSON | resolve one exact Member to a manual Pi startup specification |
| `session resume --role <exact-role>` | agent | TOON | text, JSON | pick one current-Crew role-attributed Pi Session |
| `session live` | automation/diagnostic | TOON | text, JSON | list reachable Pi sessions |
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
└── session
    ├── capture                # Crew Session capture (TASK-0204)
    ├── add                    # Crew Session member addition
    ├── list                   # Crew Session listing (canonical)
    ├── show                   # Crew Session inspection
    ├── resolve                # Crew Session manual resume
    ├── resume                 # current-Crew role-attributed Pi Session picker
    └── live                   # live Pi Session discovery (TASK-0061, renamed from `session list`)
```

Top-level `send` and the `crew session ...` rejection path are removed (v0); Commander treats them as any other unknown command.

## Terms at point of use

Help must use these short definitions where a term first affects a decision. Long comparisons belong in the future `help delivery` guide.

- **Joined Member**: current Pi session has claimed one exact manifest Member identity.
- **Source session**: live Pi runtime used to send a command (`pi-bebop session live` discovers available sessions). It is transport, not Crew/Member identity; normal name-first recovery must not ask users to choose one.
- **Socket**: explicit local transport endpoint used by low-level diagnostics.
- **Crew Intake**: one-way external → configured Crew contact delivery. It is not Broadcast or Guest membership.
- **Follow-up**: non-interrupting message; if recipient is busy it queues behind active work.
- **Redirect**: message inserted into active work to change the next model step.
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

Commander owns duplicate-option behavior (last value wins). `--instruction` remains ordered, repeatable, and bounded. There is no application-owned argv pre-scanner.

## Stable CLI boundary

| Surface | Contract |
| --- | --- |
| Successful command semantics | Preserve protocol payloads, ordering, cancellation, authorization, and domain outcomes. |
| Scalar options | Commander owns duplicate handling; the last value wins. |
| Repeatable instructions | Preserve source order and existing bound. |
| Help | Commander-generated `-h`/`--help`/`help [command]` at root, group, and leaf; stdout, exit 0; exact bytes are not a contract. |
| Option sentinel | Standard `--` ends option parsing; a flag-looking value uses `--flag=--value`. |
| Error wording | Commander usage prose is presented verbatim; only stream placement and exit class are the contract. |
| Exit codes | 0 success/help/idempotent no-op; 1 operational failure; 2 usage failure; 130 caller SIGINT where a blocking command defines it. |
| No arguments | Commander root help on stdout, exit 0. |
| Version | Commander `.version()`: one text line on stdout, exit 0. |

Unknown or missing input names the offending value and valid local alternatives. Validation happens before network, filesystem, socket, or subprocess work.

## Result and rendering boundary

A canonical result is format-independent domain/application data. A command presenter selects a safe semantic view before the single serializer boundary.

- Never serialize internal objects by spreading them blindly.
- Default views contain only fields needed for the next decision.
- Session IDs, socket paths, capabilities, raw Request IDs, stack traces, dependency payloads, and message content are excluded unless the command contract explicitly makes a safe subset public.
- TOON and JSON encode the same normalized value. TOON uses `@toon-format/toon`; no handwritten encoder/parser.
- Text conveys the same outcome in a concise human view, but is not required to round-trip. Bounded canonical presenters select only decision-relevant fields; they never dump a raw result object. Session lists show identity, aliases, membership, totals, and omissions; crew init shows state, target, paths, and the next command; communication receipts show only delivery/request facts.
- Successful results go to stdout in the selected format (`text|toon|json`). Usage failures and operational failures are concise plain text on stderr (exit 2 and 1 respectively) and are never wrapped in TOON/JSON envelopes; `--format` never affects failure output.
- Empty results state query scope and zero count.
- Lists state total separately from shown count and remain deterministic.
- Truncated fields include `truncated`, original size, shown size, and a runnable `--full` hint only when truncation occurred.

A syntax failure shows the addressed command's local usage plus Commander's suggestion when available. Help always remains text on stdout with exit 0.

## Pre-migration representative baseline

These canonical samples were captured before Commander execution migration. Byte counts are UTF-8 and illustrative, not universal savings claims. TOON was decoded with `@toon-format/toon` and deep-equaled the JSON-normalized value for every structured sample.

| Sample | Text | TOON | JSON | TOON round-trip |
| --- | ---: | ---: | ---: | --- |
| four Crew roles | 50 B | 122 B | 186 B | equal |
| queued Accepted Follow-up | 41 B | 123 B | 135 B | equal |
| empty session list (Crew Sessions, TASK-0204) | 24 B | 79 B | 89 B | equal |

Earlier current-output characterization also found `crew roles` at 296 B TOON versus 37 B text, `session list --format text` (Pi Sessions) losing rows and returning only `Message completed`, and home at 552 B structured output. These defects justify audience-specific presenters; they are not preserved behavior. `session live` lists reachable Pi sessions; `session list` lists durable Crew Sessions.

Baseline path coverage required before migration tests:

| Path | Required observation |
| --- | --- |
| Happy | stable semantic fields, selected default, clean stderr |
| Empty | explicit scope and zero count |
| Usage error | offending input, valid alternatives, exit 2, no dependency call |
| Operational error | product error code/message, one safe recovery, exit 1, no raw dependency data |
| Truncated | preview plus original/shown sizes and `--full` escape |

## Change gate

Any change to audience defaults, exit classes, scalar-option policy, option sentinels, or serialization boundaries requires an explicit contract update rather than an incidental parser change.
