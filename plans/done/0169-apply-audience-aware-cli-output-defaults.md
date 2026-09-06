---
id: TASK-0169
title: Apply audience-aware CLI output defaults
status: done
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
- [x] Home remains compact TOON by default and gains an explicit text/JSON route without losing its no-argument state behavior. Evidence: policy matrix in `audience-policy.test.ts` and existing CLI contract tests.
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
- Safe current gate: repeated `npm run verify:cli` runs used the same command/config and each had **672/672 CLI tests pass**; each exited 1 only because the configured 90% branch gate remains red. Observed branch coverage range: **89.57–89.69%**.
- Clean TASK-0168 commit `09d5fd7` in a detached worktree produced 642/642 tests and 95.38% line / 89.38% branch / 79.39% functions, also exit 1. Using the observed minimum, current focused coverage is **+0.19 branch points above** that clean baseline; no 0169-introduced uncovered policy/stdin branches remain.
- `src/cli/audience-policy.test.ts` now uses a parser-only 16-leaf explicit-format matrix. The unsafe live-session matrix was removed; the file has no `runCli`, socket, `sendRpcCommand`, or `PI_SESSION_ID` usage. Existing live checks were removed from this policy test as well.
- Exact residual uncovered branches and the TASK-0193 update are recorded in `plans/todo/0193-stabilize-cli-branch-coverage-gate-out-of-its-flake-band.md`.

## Reopened evidence (06-09-26)

Focused parser-only coverage raised current `verify:cli` from 89.22% to an observed **89.57–89.69% range** under the same command/config. The minimum, 89.57%, exceeds the clean TASK-0168 baseline of 89.38% by **+0.19 points**. TASK-0169's baseline condition is satisfied; the configured 90% gate remains honestly red and TASK-0193 remains responsible for the residual path to 90%.
