---
id: TASK-0056
title: Define modern CLI command contract and library
status: todo
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

- [ ] Characterization tests lock the current command tree, flags/defaults, repeated `--instruction`, stdin/message exclusivity, target requirements, relative paths, home schema, output formats, error behavior, and exit codes before framework changes.
- [ ] Library comparison records maintenance, ESM/Node 22 support, dependencies and packed size, nested commands, typed flags/enums, strict unknown-input behavior, aliases, generated help, test injection, and output/exit interception.
- [ ] A focused spike proves the selected library can preserve deterministic AXI handling: validation before IO, structured usage errors on stdout, no implicit process exit, and no library diagnostics contaminating stdout/stderr.
- [ ] No-argument behavior remains compact project state rather than full help; every command has local `--help` with defaults and 2–3 runnable examples.
- [ ] Existing public commands and flags remain executable with the same semantic results; `--crew` remains command-local manifest consent and is never reused globally.
- [ ] Flag policy is explicit: canonical long names, no new short aliases without separate evidence, stable kebab-case, positive booleans, and no flag whose meaning changes by target mode.
- [ ] Help policy explicitly decides whether root/send help are additive features (currently only `crew init --help` succeeds); all accepted help is deterministic human text with zero operational IO, while structured results and usage errors remain at the existing TOON/JSON/text boundary.
- [ ] Current edge cases (`--x=y`, `--`, duplicates, positionals, and usage-error format detection including `--format=json`) are either preserved or changed only through an explicit tested contract decision.
- [ ] Decision includes dependency ownership, version pinning, license, build/package inclusion, upgrade policy, and rejected alternatives.

## Verification

- Run contract tests against Citty first and Commander as fallback; keep Cleye comparison evidence without implementing three production adapters.
- Compare representative help/error bytes, bundled CLI delta from the current ~352 KB baseline, and packed dependency footprint.
- Record chosen library and rationale in the task before marking done.

