---
id: TASK-0165
title: Define CLI audience and compatibility contract
status: todo
depends_on: []
priority: high
tags: [cli, commander, output, toon, text, axi, contract]
---

# Define CLI audience and compatibility contract

## Problem

The CLI currently treats every result as TOON-first and duplicates parser behavior outside Commander. Before refactoring, each command needs an explicit primary audience, default format, supported overrides, and intentional grammar compatibility boundary.

## Desired outcome

One reviewed contract classifies commands by the next decision their output supports. Primary audience, not whether a command happens to be read-only, determines its default.

| Default | Commands |
| --- | --- |
| TOON — LLM/automation-first | home; `send`; `crew roles`; `session list`; all `member` commands; `crew broadcast`; all `guest` commands |
| Text — human-first | `crew init`; future `doctor` (with explicit TOON/JSON overrides) |
| Text only | root/leaf help and version; future `help delivery` and `quickstart` guidance |

Every result-producing leaf keeps explicit `--format text|toon|json` for compatibility and interoperability. Home gains an explicit format route while remaining TOON by default. Help and version do not gain structured wrappers.

## Commander grammar boundary

- Commander owns root/group/leaf dispatch, option and positional syntax, defaults, repeatables, help, version, and generated usage errors.
- Domain code continues to own duration/range checks, message-source and target rules, UTF-8 limits, path/trust/session resolution, security semantics, transports, and result data.
- Repeated scalar options remain usage errors; ordered `--instruction` remains repeatable and bounded. Commander normally keeps the last scalar value, so one central app-owned Commander option hook/policy must enforce duplicate rejection without restoring per-command argv scanners.
- Standard `-h` and `--help` work at root and leaf levels.
- Commander-standard `--` ends option parsing. Flag-looking option values use `--flag=--value`; the legacy `--flag -- --value` escape is intentionally retired with a targeted migration error or help note.
- Exact legacy help/error bytes are not a goal. Exit codes remain 0 success/help/no-op, 1 operational failure, and 2 usage failure.
- Successful command semantics, protocol payloads, ordering, cancellation, and authorization do not change.

## Acceptance criteria

- [ ] README or a dedicated CLI contract records every current command, primary audience, default, overrides, and next decision.
- [ ] The command hierarchy groups operations by user intent and defines joined/source session, socket, Intake, Redirect/legacy steer, Follow-up, Response grace, Accepted, Persisted, Completed, and Response at point of use or through one canonical delivery guide.
- [ ] CLI help and recovery hints reference runnable CLI commands, never agent-only tool names.
- [ ] Representative happy, empty, usage-error, operational-error, and truncated outputs are captured before implementation.
- [ ] Equivalent canonical results are measured as UTF-8 text/TOON/JSON; TOON samples decode and deep-equal the JSON-normalized value.
- [ ] The intentional help, duplicate, sentinel, and error-wording compatibility choices above are explicit and tested as the migration baseline.
- [ ] Contract distinguishes serialization from semantic views and forbids rendering internal details blindly.
- [ ] Lead and product review the matrix before parser work starts.

## Non-goals

- Changing domain behavior, RPC schemas, tools, or wire protocol.
- Removing JSON compatibility.
- Making every command human-first because it runs in a terminal.

## Evidence

Current representative output shows why audience matters: `crew roles` is 296 bytes as default TOON versus 37 bytes as text; `session list --format text` currently loses its rows and prints only `Message completed`; home is a 552-byte structured agent state view. These samples guide the plan but are not universal size claims.
