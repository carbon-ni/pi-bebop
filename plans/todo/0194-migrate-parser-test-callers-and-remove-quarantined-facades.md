---
id: TASK-0194
title: Migrate parser-test callers and remove quarantined CLI facades
status: todo
depends_on: [TASK-0168, TASK-0169]
priority: normal
tags: [techdebt, cli, commander, compatibility, cleanup]
---

# Migrate parser-test callers and remove quarantined CLI facades

## Problem

TASK-0168's Commander migration left the legacy `parseXxxCommand` facades, `parser.ts` compatibility dispatch (`parseCliCommand`), `scanCliFlags` pre-passes, and per-command `mapCommanderError` copies in place as a quarantined compatibility surface. Production dispatch/read paths no longer use them, but they still load in production modules (registry imports two compat facades for `parse:` slots) and their direct test callers keep the dead grammar duplicated. Until removed, every command has two grammars to keep in sync.

## Scope

- Migrate direct parser tests (`cli-contract`, `arguments`, `send-parser`, per-command facade tests) to exercise the Commander reader path (`leaf.read`) or the adapter boundary instead of `parseXxxCommand`.
- Resolve the PO-pinned message-wording contract first: facades emit `Unknown flag '--x'`; Commander emits `unknown option '--x'`. Either map adapter errors to the legacy wording (preserves docs/CLI-CONTRACT.md) or get an explicit PO decision to change the contract text — record it on this card.
- Delete: per-leaf `parse:` facades, `parseLeafCommand`-style shims if any remain, `parseCliCommand` dispatch, remaining `scanCliFlags` imports, per-command `mapCommanderError` copies.
- Keep `src/cli/support/flag-scanner.ts` and `src/cli/parser.ts` only if a non-CLI caller remains; otherwise delete both.

## Trigger

Start only when ALL of: (1) TASK-0169 output-defaults WIP has landed or been reverted (the toon↔text default conflict currently reddens 7 crew-init tests); (2) the PO message-wording decision above is recorded; (3) no teammate holds uncommitted work in `src/cli/` (shared-tree discipline).

## Acceptance criteria

- [ ] No production file imports `parser.ts` or `scanCliFlags`; `rg "scanCliFlags|parseCliCommand" src/cli --glob '!*test*'` returns only intentional support internals or is empty.
- [ ] Command modules export readers only; compat facades and their duplicate grammar are gone.
- [ ] Adapter owns all Commander-error translation with the agreed wording contract.
- [ ] Full suite, `make all`, and `verify:cli` green on a clean tree; `ast_module_graph src/cli` still reports zero cycles.
- [ ] Card records the wording decision with its owner and date.

## Out of scope

New command behavior, output defaults (0169), presenters (0170), or grammar changes — pure compat-surface removal.
