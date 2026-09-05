---
id: TASK-0169
title: Apply audience-aware CLI output defaults
status: todo
depends_on: [TASK-0168]
priority: high
tags: [cli, output, toon, text, json, axi, tdd]
---

# Apply audience-aware CLI output defaults

## Problem

A global TOON fallback ignores whether a command primarily serves an LLM or a human, including parse failures before command options exist. Output defaults must derive from an explicit per-command audience policy while preserving format overrides.

## Desired outcome

The TASK-0165 audience matrix is executable policy owned in one place:

- LLM/automation-first result commands default to TOON.
- Human-first result commands default to plain text.
- Explicit `--format text|toon|json` overrides either default.
- Help and version remain concise plain text, not result envelopes.

## Acceptance criteria

- [ ] Each result-producing command declares one primary audience/default without repeating literal fallback logic across parsers or handlers.
- [ ] Agent-first defaults remain TOON for home, `send`, `crew roles`, `session list`, all `member` commands, `crew broadcast`, and all `guest` commands.
- [ ] `crew init` defaults to readable text while explicit TOON and JSON preserve its canonical structured data.
- [ ] Home remains compact TOON by default and gains an explicit text/JSON route without losing its no-argument state behavior.
- [ ] Usage errors select the matched command's default even when option parsing fails; an explicit valid format is honored when recoverable.
- [ ] Structured operational errors use the same selected format as success; help/version never acquire TOON envelopes.
- [ ] Exit codes, stdout/stderr separation, truncation, `--full`, and one-write behavior remain deterministic.
- [ ] Tests cover every command's default, each explicit override, malformed format, unknown command, parse failure before options, empty/no-op, and operational failure.
- [ ] No global `toon` fallback remains outside the audience policy.

## Constraints

Audience and serialization are presentation policy only. Canonical result objects and business handlers must not depend on TOON, JSON, or human wording.
