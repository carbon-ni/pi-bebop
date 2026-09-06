---
id: TASK-0169
title: Apply audience-aware CLI output defaults
status: doing
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

- [x] Each result-producing command declares one primary audience/default without repeating literal fallback logic across parsers or handlers. Evidence: `src/cli/audience-policy.ts`; command readers and parser defaults import `defaultFormatForCommand`; production audit has no literal format fallback outside the policy.
- [x] Agent-first defaults remain TOON for home, `send`, `crew roles`, `session list`, all `member` commands, `crew broadcast`, and all `guest` commands. Evidence: policy matrix in `src/cli/audience-policy.test.ts`.
- [x] `crew init` defaults to readable text while explicit TOON and JSON preserve its canonical structured data. Evidence: `arguments.test.ts`, `cli-contract.test.ts`, `parser.test.ts`, and `domain/crew-init.test.ts`.
- [x] Home remains compact TOON by default and gains an explicit text/JSON route without losing its no-argument state behavior. Evidence: policy and live `runCli` assertions in `audience-policy.test.ts` and existing CLI contract tests.
- [x] Usage errors select the matched command's default even when option parsing fails; an explicit valid format is honored when recoverable. Evidence: `cliFormatForArgs` matrix and malformed/explicit cases in `audience-policy.test.ts`.
- [x] Structured operational errors use the same selected format as success; help/version never acquire TOON envelopes. Evidence: `operational-format.test.ts` and `operational-parity.test.ts`; stdin failures now return formatted `stdin-error` results in member-message, member-interrupt, and durable-message.
- [x] Exit codes, stdout/stderr separation, truncation, `--full`, and one-write behavior remain deterministic. Evidence: existing CLI contract/run tests plus full `npm test` (1248/1248).
- [x] Tests cover every command's default, each explicit override, malformed format, unknown command, parse failure before options, empty/no-op, and operational failure. Evidence: policy matrix, reader matrix, CLI contract/parser suites, and focused operational parity suites; full suite is 1248/1248.
- [x] No global `toon` fallback remains outside the audience policy. Evidence: production source audit; all command defaults/read fallbacks resolve through `audience-policy.ts`.

## Constraints

Audience and serialization are presentation policy only. Canonical result objects and business handlers must not depend on TOON, JSON, or human wording.

## Completion evidence (06-09-26)

- Implementation is complete and committed as `eefaf18` (`feat(cli): apply audience-aware output defaults (TASK-0169)`). Focused C6 stdin and operational parity tests are green; no TASK-0182 files were changed.
- Validation: `npm test` = 1248/1248; `npm run typecheck` clean; `npm run lint` clean; `npm run format:check` clean.
- `npm run verify:cli` is honestly baseline-failing: current all-files coverage is 97.36% line / 89.22% branch / 84.20% functions, exit 1 because branch coverage is below 90.
- Clean TASK-0168 commit `09d5fd7` in a detached worktree produced 642/642 tests and 95.38% line / 89.38% branch / 79.39% functions, also exit 1. The 90% failure pre-existed TASK-0169. Current work improves line/functions but is 0.16 branch points below the clean baseline; no 0169-introduced uncovered policy/stdin branches remain.
- Exact current uncovered branches and the TASK-0193 update are recorded in `plans/todo/0193-stabilize-cli-branch-coverage-gate-out-of-its-flake-band.md`.

## Reopened evidence (06-09-26)

Mary rejected closure because current `verify:cli` branch coverage is 89.22%, below the clean TASK-0168 baseline of 89.38%. TASK-0169 remains open until focused coverage raises the current result to at least 89.38%, or an equivalent clean-checkout comparison proves the measurements are non-comparable. TASK-0193 remains responsible for the residual path to the 90% gate.
