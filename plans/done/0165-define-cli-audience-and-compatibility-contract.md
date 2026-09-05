---
id: TASK-0165
title: Define CLI audience and compatibility contract
status: doing
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

## Normative contract

`docs/CLI-CONTRACT.md` owns the audience matrix, hierarchy, format defaults, vocabulary, rendering boundary, and intentional Commander compatibility decisions.

## Acceptance criteria

- [x] Dedicated CLI contract records every current command, primary audience, default, overrides, and next decision.
- [x] Command hierarchy groups operations by intent and defines joined/source session, socket, Intake, Redirect/legacy steer, Follow-up, Response grace, Accepted, Persisted, Completed, and Response at point of use.
- [x] CLI help and recovery hints must reference runnable CLI commands, never agent-only tool names; the discovered `member status` violation now points to `pi-bebop member request send|wait` and has a regression test.
- [x] Representative happy, empty, usage-error, operational-error, and truncated output observations are captured before implementation.
- [x] Equivalent canonical results are measured as UTF-8 text/TOON/JSON; checked-in contract coverage decodes all three TOON samples and deep-equals their JSON-normalized values.
- [x] Intentional help, duplicate, sentinel, error-wording, and exit-code compatibility choices are explicit migration baselines.
- [x] Contract distinguishes serialization from semantic views and forbids rendering internal details blindly.
- [x] Lead review approves the product-authored matrix before parser work starts; known Guest parser/help/text gaps are explicitly assigned to TASK-0168/TASK-0166–0170.

## Non-goals

- Changing domain behavior, RPC schemas, tools, or wire protocol.
- Removing JSON compatibility.
- Making every command human-first because it runs in a terminal.

## Evidence

Product review: Mary approved `docs/CLI-CONTRACT.md` as the intended behavior for TASK-0166–0170. The contract explicitly records current Guest parser, leaf help, and text presentation gaps under their migration owners rather than claiming current conformance.

Measured canonical samples: Crew roles 50/122/186 B, queued Follow-up 41/123/135 B, and empty session list 24/79/89 B for text/TOON/JSON. `@toon-format/toon` decode deep-equaled every JSON-normalized sample. Current representative output also shows why audience matters: `crew roles` is 296 B as default TOON versus 37 B as text; `session list --format text` loses its rows and prints only `Message completed`; home is a 552 B structured agent state view. These samples guide the plan but are not universal size claims.

Lead re-review at exact HEAD `55c2912`: approved. Focused contract/member-status suite passes 46/46 and `npm run lint` passes. The Guest parser defect, leaf-help gap, and incomplete text presenter are documented as pre-migration gaps with explicit downstream owners; the CLI contract is internally consistent and unblocks TASK-0166.
