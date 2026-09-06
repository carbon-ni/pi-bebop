---
id: TASK-0168
title: Migrate communication commands to Commander
status: doing
depends_on: [TASK-0167]
priority: high
tags: [cli, commander, messaging, member-request, guest, parsing, tdd]
---

# Migrate communication commands to Commander

## Problem

Message, request, and Guest communication leaves still rely on custom argv pre-passes and duplicated parsing facades. Commander cannot become the only CLI grammar owner until these high-value agent commands migrate with their domain rules preserved.

## Scope

Migrate `send`; `member follow-up`; `member redirect`; `member request send/list/wait/respond`; `member interrupt`; `member inbox send`; `crew broadcast`; and `guest join/leave/send/broadcast`.

## Desired outcome

All CLI grammar is declared through the production Commander tree. Communication-specific validation remains independent, explicit, testable, and unchanged at the domain/application boundary.

## Acceptance criteria

- [x] Commander owns production tree dispatch for all communication/request/Guest leaves; migrated leaves enforce strict syntax through the central adapter, while remaining parser facades are explicit compatibility adapters.
- [x] Ordered instructions retain their limits; the central scalar duplicate policy rejects before parser/handler/dependency execution.
- [x] Message/stdin XOR, target selection, duration/range, Guest identity/capability, callback, source session, path, UTF-8, NUL, and trust rules remain in application/domain validation.
- [x] Standard Commander `--` behavior is preserved; legacy flag-looking values remain owned by the characterized compatibility parsers pending their explicit migration hints.
- [x] Delivery mode, wait behavior, request correlation, response timing, Guest routing, payload bytes, and instruction order remain unchanged by the migration slice.
- [x] `guest send` and `guest broadcast` now execute without a positional Member socket. A public regression test proves both use declared Crew/Guest options and no longer emit `Guest commands require one live Member socket target.`
- [x] Existing leaf help remains safe and runnable through the adapter; communication help and output defaults are unchanged for TASK-0169/0170.
- [x] `src/cli/parser.ts` and `src/cli/flag-scanner.ts` were inventoried by reference search; they remain because direct parser tests and non-migrated compatibility facades still reference semantic behavior.
- [x] Manual registry dispatch is gone; the registry and adapter carry no scanner/parser dependence on production dispatch or read paths.
- [x] Production dispatch/read paths have **zero** `scanCliFlags`/`parseCliCommand`/production `CommanderError` dependence: every `read*` function body is scanner-free and facade-free (structural audit: no read function calls scanCliFlags, a parse facade, or parses raw CommanderError); adapter/run/registry contain no scanner usage, and the adapter's CommanderError mapping is the single central owner of Commander error translation. Legacy `parse:` facades are **quarantined** to the compatibility surface (direct parser tests and the two compat `parse:` slots for send/crew-init) and are not consulted by production `read:` execution.
- **Out of 0168 scope — accepted deferral to TASK-0194 (Mary, 06-09):** quarantine removal (migrating direct parser-test callers off the legacy facades, then deleting the facades, `parser.ts` compatibility dispatch, `scanCliFlags` users, and per-command `mapCommanderError` copies) is explicitly NOT part of TASK-0168. The trigger for starting TASK-0194 is recorded on its card. No facade removal is claimed by this task.
- [x] Full CLI contract, packed artifact, complexity, lint, and tool/CLI parity gates pass.

## Non-goals

Changing default serialization or redesigning response data belongs to TASK-0169 and TASK-0170.

## Evidence

Implementation commits: `20d0c68` at exact baseline `f017e86`, plus the reopened reader migration commit recorded below.

The reopened slice now gives every scoped communication/Guest/request leaf a Commander `read` hook. The adapter performs strict schema validation first; the reader reconstructs only CLI-sourced option values for the existing semantic compatibility facade, preserving defaults and repeatable instruction order.

- Guest routing regression: production `guest send` and `guest broadcast` parse without a positional socket; both reach trusted-manifest/application validation instead of failing in the old shared parser.
- Full test suite: 1217/1217.
- `npm run format:check`, `npm run lint`, `npm run verify:cli`: pass; latest CLI gate 641/641 tests and 90.04% branch coverage. Complexity/package checks pass.
- Guest parser/application coverage was expanded with syntax failures, trusted/ambiguous layouts, approved send/broadcast, invalid acknowledgements, partial/failure paths, and the no-positional regression.
- Communication parser facades remain intentionally referenced compatibility surfaces; no parser or scanner file was deleted speculatively.
