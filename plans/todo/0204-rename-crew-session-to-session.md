---
id: TASK-0204
title: Rename `pi-bebop crew session ...` to `pi-bebop session ...`
status: done
depends_on: [TASK-0203]
priority: high
tags: [cli, crew, session, rename, contract, tdd, docs, ul]
---

## Status

Done. Commits `78b797c` (rename + tests) and `915f8ae` (prettier) on branch
`task-0204-cli-rename-session`; PR `carbon-ni/pi-bebop#18` opened, awaiting QA.


# Rename `pi-bebop crew session ...` to `pi-bebop session ...`

## Problem

TASK-0201..0203 shipped the five Crew Session leaves under the `crew session ...` prefix while the existing `pi-bebop session list` (TASK-0061) already occupied the bare `session ...` namespace for live Pi Session discovery. The current `crew session <sub>` path is redundant, verbose, and harder to discover, and the long prefix leaks the implementation grouping into product vocabulary. We need a clean rename to `session ...` that preserves all five Crew Session behaviors and gives a clear replacement hint on the legacy nested path.

## Desired outcome

`pi-bebop session capture | add | list | show | resolve` is the single canonical CLI surface for the Crew Session contract. `pi-bebop crew session ...` is no longer a supported path; callers receive a deterministic `UsageError` with the exact replacement command. The existing `session list` (live Pi Session discovery, TASK-0061) moves to `session live` so the new `session list` (Crew Sessions) can own the canonical name; the discovery hint (`SESSION_LIST_HINT`) and every CLI/help/error/docs/UL/plan reference update to `pi-bebop session live`. No compatibility alias is added; no coverage is lowered.

## Target commands

```text
pi-bebop session capture <name> [--crew <locator>] [--format toon|json|text]
pi-bebop session add <crew-session-id> <member> [--format toon|json|text]
pi-bebop session list [--crew <locator>] [--limit <count>] [--offset <count>] [--format toon|json|text]
pi-bebop session show <crew-session-id> [--format toon|json|text]
pi-bebop session resolve <crew-session-id> <member> [--format toon|json|text]
# Live Pi Session discovery (was pi-bebop session list):
pi-bebop session live [--format toon|json|text]
# Rejected legacy nested path:
# pi-bebop crew session <capture|add|list|show|resolve> → UsageError + replacement hint
```

## Design notes

- New leaves live under the `session` group; `GROUP_DESCRIPTIONS.session` keeps its current "Session commands" wording because the group now owns both Crew Session and live Pi Session discovery.
- `session-list` (TASK-0061, live Pi Sessions) is renamed to `session-live` with `names: ["session", "live"]` to free `session list` for the Crew Session list. The leaf id and exports become `session-live`; only the underlying `session-list.ts` module file name is preserved for diff hygiene.
- The legacy `crew session ...` paths are rejected by a single synthetic leaf registered with `names: ["crew", "session"]`. It throws `UsageError` with the exact replacement hint before any IO. No `crew-session-*` leaves remain in the registry.
- All internal export names (`crewSessionCaptureCliOptions`, `runCrewSessionCaptureCommand`, etc.) stay unchanged; the rename is strictly at the user-visible command tree and help/error/doc layer.
- `SESSION_LIST_HINT` (used by every member/inbox/interrupt/idle-wait leaf for `session-required` / `invalid-session` errors and help) updates to `pi-bebop session live`.

## Acceptance criteria

- [x] `pi-bebop session capture`, `pi-bebop session add`, `pi-bebop session list`, `pi-bebop session show`, and `pi-bebop session resolve` parse, help, dispatch, and produce the same exit codes, status codes, JSON/TOON/text payloads, and bounded behaviors as the prior `pi-bebop crew session ...` commands. No behavior change to capture/list/show/add/resolve beyond the rename.
- [x] `pi-bebop crew session ...` (any prefix: bare, `capture`, `add`, `list`, `show`, `resolve`) exits 2 with `UsageError` whose message names `pi-bebop session <capture|add|list|show|resolve>` as the replacement. No IO, manifest read, socket probe, session-file read, or store read happens for the rejected paths. Direct no-IO coverage in `src/cli/crew-session-rejected.test.ts`.
- [x] `pi-bebop session live` (formerly `pi-bebop session list`) parses, helps, dispatches, and returns the same bounded reachable-session rows / joined-state / empty / control-store-unavailable contract as before. Live Pi Session discovery is preserved.
- [x] Root/home help, `pi-bebop --help`, every leaf `--help`, and every error message references the new vocabulary (`session capture | add | list | show | resolve` and `session live`). `pi-bebop session list` help text mentions `crew session capture` is no longer a supported path only via the rejected-path error.
- [x] `SESSION_LIST_HINT` is `pi-bebop session live`. Every member/inbox/interrupt/idle-wait/help and contract test that referenced the old hint points at the new command.
- [x] README "Preserve exact Member sessions" section, `docs/CREW-SESSION.md` (every code block, every example, the inspection/CLI sections), `docs/CLI-CONTRACT.md` vocabulary matrix and command-tree diagram, and the `UL.md` Crew Session/Pi Session terms reference the new `pi-bebop session ...` paths.
- [x] `parseCliCommand` vocabulary listing (home output, usage errors, registry contract test) drops `crew session capture | add | list | show | resolve`, drops `session list`, adds `session capture | add | list | show | resolve`, and adds `session live` in the same registry order.
- [x] `crew-session-resolution.ts` `recovery` text on `record-not-found` points at `pi-bebop session list` (the new Crew Session list), not `pi-bebop crew session list`.
- [x] Tests cover: new path parses for all 5 subcommands; new path dispatch produces identical outcomes to fixtures; old `crew session <sub>` paths throw `UsageError` with the replacement hint and never reach transport; old `crew session` (bare) also throws with the same hint; `pi-bebop session live` parses and lists live sessions; help text for every renamed leaf shows the new command; packaged CLI (built `dist/cli/main.js`) exposes the new paths.
- [x] CLI coverage gate, CLI complexity gate, packaged-CLI verification, and full test suite remain green. Coverage must not drop below the existing floor.

## Non-goals

- Removing or renaming any Crew Session domain/application/infra module or its exports.
- Changing the Crew Session record schema, storage path, or trust/safety semantics.
- Restoring or aliasing the legacy `pi-bebop crew session ...` paths.
- Editing `crew init`, `crew list`, `crew roles`, `crew broadcast`, `member ...`, `guest ...`, `send`, or `--version` behavior or vocabulary beyond updating vocabulary listings and cross-references.
- Removing the live `pi-bebop session live` discovery leaf.
- Changing the `crew list` product route; only its cross-references update.

## Plan

1. Registry: rename the five `crew-session-*` leaf names from `["crew", "session", "<sub>"]` to `["session", "<sub>"]` and rename their leaf ids to `session-capture`/`session-add`/`session-list`/`session-show`/`session-resolve`; rename the live Pi Session leaf id and names from `session-list` / `["session", "list"]` to `session-live` / `["session", "live"]`; register one synthetic `crew-session-rejected` leaf with `names: ["crew", "session"]` and `hiddenFromVocabulary: true` that throws the replacement `UsageError` and is registered in the Commander tree with `allowExcessArguments + allowUnknownOption` so the action reaches the parser. Internal `command` discriminators aligned to user-facing words (`session-capture`, `session-add`, `session-list`, `session-show`, `session-resolve`, `session-live`); module file names and function exports unchanged.
2. Help/error: rewrite every `crewSession*Help` string to use `pi-bebop session <sub> ...`; rewrite the `next` field on empty Crew Session list to `pi-bebop session capture <name>`; rewrite the legacy hint in `crew-session-resolution.ts` recovery to `pi-bebop session list`; rewrite `SESSION_LIST_HINT` to `pi-bebop session live`; rewrite `crew-session-rejected` leaf message to point at `pi-bebop session <capture|add|list|show|resolve>`.
3. Tests: update `crew-session.test.ts`, `session-list.test.ts`, `cli-contract.test.ts`, `main.test.ts`, `registry-contract.test.ts`, `audience-policy.test.ts`, `membership-parity-contract.test.ts`, `output.test.ts`, and `source-session.test.ts` to reflect the new vocabulary. Add a new `crew-session-rejected.test.ts` that covers all six rejected inputs (bare + five subcommands) and confirms the `UsageError` replacement hint, zero IO, hidden vocabulary, Commander tree shape, and packaged-CLI dispatch.
4. Docs/UL/README/parity: update `docs/CREW-SESSION.md` (every code block, example, inspection section), `docs/CLI-CONTRACT.md` (vocabulary matrix and command-tree diagram), `README.md` (Preserve exact Member sessions section), `UL.md` (Crew directory / Pi Session terms), `docs/cli-membership-parity.json` (`sessionList.command`, `recoveryHint`, `empty.next`), and the historical plans `0200`/`0201`/`0202`/`0203` (their command examples and `next` references) to use the new `pi-bebop session ...` and `pi-bebop session live` paths.
5. Verification: green for `npm test` (1299/1299), `npm run verify:cli` (coverage + complexity + packaged CLI), `npm run lint`, `npm run format:check`, `npm run verify:package`, `node scripts/security-check.mjs`. Packaged `dist/cli/main.js` smoke: home/vocabulary excludes `crew session` and `session list` (Pi); `pi-bebop session --help` lists all six leaves; `pi-bebop crew session ...` exits 2 with the replacement hint; `pi-bebop session <sub> --help` and `pi-bebop session live --help` exit 0 with the new help text.
