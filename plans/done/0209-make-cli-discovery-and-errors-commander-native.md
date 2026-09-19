---
id: TASK-0209
title: Make CLI discovery and errors Commander-native
status: done
depends_on: []
priority: high
tags: [cli, commander, discoverability, breaking-change, cleanup]
---

# Make CLI discovery and errors Commander-native

## Problem

`pi-bebop` already uses Commander for command selection, but custom adapters hide most of Commander's user experience. Root help is hand-built and flattened, leaf help comes from parallel prose functions, usage failures become TOON envelopes on stdout, and legacy parser facades duplicate the grammar. The result is hard to discover and expensive to maintain.

Representative failures today:

- `pi-bebop` prints live TOON state instead of showing how to use the CLI.
- `pi-bebop crew nope` reports “too many arguments” instead of an unknown Crew subcommand and relevant choices.
- `pi-bebop wat` prints a large TOON error with every leaf command flattened into one message.
- Every new option can require updates in the Commander builder, a parser facade, error mapping, manual help, and tests.

## Desired outcome

Commander is the single source of truth for command grammar, help, usage, suggestions, and syntax-error presentation. A person can discover the next command from any level without understanding TOON. Machine-readable formats remain available for successful command data, not for CLI guidance or failure prose.

## Product decisions

- No arguments show Commander-generated root help and exit 0. The implicit live “home” result is retired; a future explicit status command can restore that capability if it proves useful.
- Root, group, and leaf help is plain text on stdout and exit 0.
- Usage and operational failures are concise plain text on stderr. They are never wrapped in TOON or JSON. `--format` controls successful result data only.
- Usage failures exit 2; operational failures exit 1; SIGINT remains 130 where the command defines it.
- A syntax failure shows the nearest command usage and Commander's suggestion when available. It does not dump the full flattened leaf vocabulary.
- Product-specific semantic validation remains custom. Deprecated aliases, rejection shims, migration hints, and compatibility-only command paths are deleted rather than preserved.
- This is a v0 CLI. Backward compatibility is not a goal. Exact Commander prose is not a contract; only the canonical command grammar, exit classes, and stream placement are.

## Acceptance criteria

### Discovery and help

- [ ] `pi-bebop` and `pi-bebop --help` show the same Commander-owned root command tree, including descriptions for `crew`, `member`, `session`, `guest`, and top-level commands.
- [ ] A bare group such as `pi-bebop member` shows that group's local help.
- [ ] Every leaf supports `-h` and `--help`; its generated help shows positional arguments, required options, defaults, and 1–3 runnable examples where examples add value.
- [ ] Help performs no Crew, session, filesystem, socket, or subprocess IO.
- [ ] Help is written to stdout, stderr stays empty, and exit code is 0.

### Self-correcting failures

- [ ] Unknown root and group subcommands identify the offending token, show only relevant local usage, and include a nearest-command suggestion when Commander can provide one.
- [ ] Unknown options, missing option values, missing required arguments, and excess arguments show the addressed command's local usage.
- [ ] Syntax failures happen before the command handler or external dependencies run.
- [ ] Usage failures write plain text to stderr, write nothing to stdout, and exit 2.
- [ ] Operational failures write concise plain text to stderr, write nothing to stdout, and exit 1.
- [ ] Failures never expose a stack trace, raw dependency output, TOON envelope, or JSON envelope.
- [ ] The retired `crew session ...` rejection leaf and its dedicated tests are deleted; Commander treats the path as any other unknown command.
- [ ] CLI surfaces documented or implemented only for backward compatibility are removed, including top-level `send`; canonical Crew, Member, Guest, and Session operations remain.
- [ ] Legacy `steer` vocabulary and byte-compatible error/help assertions are removed from the CLI surface.

### One grammar and one help source

- [ ] Commander command builders are the sole source of command names, arguments, options, descriptions, and defaults.
- [ ] Manual root-help generation, help pre-scanning, Commander-error rewording, duplicate scalar-option scanning, and leaf-help maps are removed unless a documented product rule requires one.
- [ ] Production-dead `parseXxxCommand` facades, `parseCliCommand`, `parser.ts`, and `support/flag-scanner.ts` are removed after their tests move to the Commander execution boundary.
- [ ] Long product guidance is attached to Commander commands with descriptions or after-help text; complete usage blocks are not maintained separately.
- [ ] TASK-0194 is closed as included work rather than implemented as a second parser-cleanup effort.
- [ ] README, CLI contract, registry, tests, and generated help contain no deprecated-command guidance or compatibility promises.

### Result compatibility and verification

- [ ] Successful canonical result commands retain `--format text|toon|json`; their domain payload and status semantics do not change in this task.
- [ ] Tests assert stable behavior and key content, not entire framework-generated help bytes.
- [ ] Subprocess tests cover no args, root help, group help, leaf help, unknown root command, unknown group command, misspelled command suggestion, unknown option, missing argument, operational failure, and explicit successful formats.
- [ ] Packaged CLI verification, CLI coverage, typecheck, and formatting gates pass.
- [ ] README and `docs/CLI-CONTRACT.md` describe the new stream, exit, no-argument, help, and error contracts.

## Delivery slices

1. **Pin the new contract with failing process-level tests.** Test streams, exits, local usage, no-IO behavior, and suggestions.
2. **Make command metadata complete.** Move useful prose and examples into Commander builders so generated root/group/leaf help is sufficient.
3. **Let Commander present the CLI.** Remove no-argument home dispatch, manual help routing, structured usage rendering, and error-message rewrites. Keep only process-stream adaptation, exit-class mapping, handler dispatch, and product-specific validation.
4. **Delete compatibility surfaces and duplicate grammar.** Remove deprecated commands/rejection shims, migrate useful facade tests to builders/readers or process tests, then remove parser facades and scanners covered by TASK-0194.
5. **Update public guidance and verify the package.** Document the simplified v0 contract and run focused plus final gates.

## Constraints

- Preserve non-interactive operation; no prompts.
- Preserve semantic validation before IO.
- Preserve existing business operations and successful structured payloads.
- Keep Commander configuration at the CLI composition boundary; command modules own their metadata.
- Prefer deletion over deprecation or migration shims while the product is v0.

## Non-goals

- Renaming or reorganizing canonical command groups beyond deleting compatibility-only surfaces.
- Changing Crew messaging, session, admission, or persistence behavior.
- Adding a replacement live-home/status command.
- Redesigning successful TOON/JSON schemas.
- Preserving exact legacy help, error wording, deprecated commands, aliases, or migration hints.

## Evidence

- `src/cli/execution-adapter.ts` suppresses Commander output, pre-scans help, maps framework errors, rejects duplicate options, and routes no arguments to a custom home leaf.
- `src/cli/root-help.ts` duplicates root help that Commander can generate.
- `src/cli/run.ts` converts `UsageError` into a structured result selected by `cliFormatForArgs`.
- All real command leaves already have Commander readers; the remaining parser facade is production-dead compatibility debt.
- QA characterization on 19-09-26 confirmed current help exits 0, usage failures exit 2 on stdout as TOON, and `crew nope` produces an unhelpful excess-argument error.
