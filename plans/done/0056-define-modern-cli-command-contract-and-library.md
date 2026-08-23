---
id: TASK-0056
title: Define modern CLI command contract and library
status: done
depends_on: []
priority: high
tags: [cli, architecture, axi, dependencies, compatibility]
---

# Define modern CLI command contract and library

## Problem
The standalone CLI has a hand-written high-complexity parser and one send command that combines unrelated direct-session delivery and durable Crew Intake behind mutually exclusive flags.

## Context

Characterize and preserve the current public vocabulary before choosing a
framework:

```text
pi-bebop
pi-bebop send (--socket <path> | --crew <manifest>) (--message <text> | --stdin)
pi-bebop crew init [--project <directory>]
```

`send --socket` remains direct live delivery. `send --crew` remains durable
external Crew Intake and an explicit caller-consent trust boundary; `--crew`
must not become a global flag. Preserve current defaults (`mode=steer`,
`wait=turn_end`, `timeout=5m`, `format=toon`), relative-path resolution,
no-argument home schema, and exit behavior. Organize declarations and flag
groups internally without renaming public commands in this phase. Any future
public hierarchy requires a separate product task after parity is proven.

Evaluate current maintained ESM releases of Citty, Commander, and Cleye with a
small executable contract test. Citty is the leading candidate because it is
zero-dependency, TypeScript-native, based on Node `util.parseArgs`, supports
nested/lazy commands, enums, aliases, and generated usage. Selection is not
final until error/output interception, duplicate flags, repeated values,
`--flag=value`, `--`, injected argv/IO, and package bundling are proven.

The selected library owns tokenization and deterministic help only. Application
calls, cross-flag/domain validation, trust/path policy, output rendering, IO,
and exit assignment stay outside the framework.

## Acceptance criteria

- [x] Characterization tests lock the current command tree, flags/defaults, repeated `--instruction`, stdin/message exclusivity, target requirements, relative paths, home schema, output formats, error behavior, and exit codes before framework changes.
- [x] Library comparison records maintenance, ESM/Node 22 support, dependencies and packed size, nested commands, typed flags/enums, strict unknown-input behavior, aliases, generated help, test injection, and output/exit interception.
- [x] A focused spike proves the selected library can preserve deterministic AXI handling: validation before IO, structured usage errors on stdout, no implicit process exit, and no library diagnostics contaminating stdout/stderr.
- [x] No-argument behavior remains compact project state rather than full help; every command has local `--help` with defaults and 2–3 runnable examples.
- [x] Existing public commands and flags remain executable with the same semantic results; `--crew` remains command-local manifest consent and is never reused globally.
- [x] Flag policy is explicit: canonical long names, no new short aliases without separate evidence, stable kebab-case, positive booleans, and no flag whose meaning changes by target mode.
- [x] Help policy explicitly decides whether root/send help are additive features (currently only `crew init --help` succeeds); all accepted help is deterministic human text with zero operational IO, while structured results and usage errors remain at the existing TOON/JSON/text boundary.
- [x] Current edge cases (`--x=y`, `--`, duplicates, positionals, and usage-error format detection including `--format=json`) are either preserved or changed only through an explicit tested contract decision.
- [x] Decision includes dependency ownership, version pinning, license, build/package inclusion, upgrade policy, and rejected alternatives.
- [x] PO review implications incorporated before freezing: per-action module/registry decision, shared --timeout grammar with boundary winner, and --session placement/precedence/discovery policy — each recorded in docs/CLI-FRAMEWORK-DECISION.md and test-locked where testable.

## Verification

- Run contract tests against Citty first and Commander as fallback; keep Cleye comparison evidence without implementing three production adapters.
- Compare representative help/error bytes, bundled CLI delta from the current ~352 KB baseline, and packed dependency footprint.
- Record chosen library and rationale in the task before marking done.


## Decision (recorded 26-08-2026)

**Selected library: Commander 15.0.0** (exact-pinned, MIT, zero runtime deps).

Full comparison table, spike evidence, rejected alternatives, and ownership/
upgrade policy: `docs/CLI-FRAMEWORK-DECISION.md`.

Rationale in one line: Commander is the only candidate whose parse failures are
catchable (`exitOverride` throws `CommanderError`), whose help is plain text
when piped (no env-dependent ANSI), and which dispatches exactly one action per
invocation — so the app keeps owning validation-before-IO, structured usage on
stdout, exit assignment, and output rendering. citty (smallest, zero deps) is
rejected because it swallows all parse errors, double-fires the parent `run`
after subcommands, and hardcodes exits in `runMain`; cleye (typed flags) is
rejected because it silently accepts unknown flags, emits ANSI help when piped,
and adds two runtime deps with the largest bundle delta.

Required app-owned pre-pass for the implementation task: duplicate-flag
rejection and the `--message -- --content` sentinel escape are not provided by
any candidate (all silently last-win on duplicates) — a small raw-args pre-pass
stays outside the framework, matching the declared boundary that cross-flag/
domain validation, trust/path policy, output rendering, IO, and exit assignment
are application-owned.

## PO sequencing review incorporation (26-08-2026)

Three contract implications incorporated before freezing (PO review report:
`.tmp/reports/23-08-26/task-0056-0067-plan-sequencing-review.md`; full decisions:
`docs/CLI-FRAMEWORK-DECISION.md`; test-locked in `src/cli/cli-contract.test.ts`
tests 21–23):

1. **Per-action isolation + one owned registry**: every command/action lands as an
   isolated schema/handler module through a single owned integration registry;
   central RPC union/dispatcher/parser files are never extended directly by a
   slice. Downstream 0062/0064..0067 either use the seam or are serialized.
2. **Shared `--timeout` duration grammar**: duration-valued everywhere
   (`500ms|30s|5m`); bare seconds rejected (test-locked). Idle-wait distinguishes
   connection/setup deadline from idle operation deadline; first-to-fire wins,
   idle deadline reported on simultaneous expiry.
3. **`--session` policy**: leaf-command-local only, explicit > `PI_SESSION_ID`
   (safe exact id), self-correcting discovery with copyable next step in
   unknown/missing/offline errors; not global today (test-locked).
