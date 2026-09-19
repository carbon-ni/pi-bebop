---
id: TASK-0210
title: Default CLI results to plain text
status: done
depends_on: [TASK-0209]
priority: high
tags: [cli, output, usability]
---

# Default CLI results to plain text

## Problem

Commander now makes discovery and failures readable, but successful commands such as `pi-bebop crew roles` still default to TOON. That is strange in an interactive terminal and undermines the human-first CLI.

## Desired outcome

Every canonical CLI command defaults to concise plain text. TOON and JSON remain explicit choices for large results, automation, or lossless structured consumption.

## Product rule

- Default format is always `text`; it never changes automatically based on result size.
- Use `--format toon` for large or agent-oriented structured output.
- Use `--format json` for interoperability.
- Errors and help remain plain text as defined by TASK-0209.

## Acceptance criteria

- [ ] Every canonical CLI command with `--format` defaults to `text`.
- [ ] `pi-bebop crew roles` prints only the concise human presenter by default.
- [ ] Command help consistently says `text (default), toon, or json`.
- [ ] Explicit `--format toon` and `--format json` preserve their existing schemas and data.
- [ ] Large text results remain bounded and point to `--format toon` only when structured detail is omitted or truncated.
- [ ] CLI tests cover default text plus explicit TOON and JSON for representative list, detail, and mutation commands.
- [ ] README and `docs/CLI-CONTRACT.md` state that CLI output is human-first and structured formats are opt-in.
- [ ] Pi extension tool output contracts are unchanged.
- [ ] CLI verification and final quality gates pass.

## Non-goals

Automatic format switching based on response size, schema redesign, or changing extension-tool output.
