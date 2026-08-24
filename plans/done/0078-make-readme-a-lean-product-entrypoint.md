---
id: TASK-0078
title: Make README a lean product entrypoint
status: done
depends_on: []
priority: high
tags: [readme, documentation, onboarding, product, ux]
---

# Make README a lean product entrypoint

## Problem

`README.md` is 419 lines and 2,301 words. It mixes product pitch, installation,
quick start, manifest/path security, roster behavior, role instructions,
presence, full CLI surface, messaging semantics, Inbox lifecycle, Intake,
Broadcast, development, and release detail. Reader cannot quickly answer: what
is Bebop, why use it, how install it today, and how start first Crew.

## Context

Make README product front door, not reference manual. Preserve Bebop illustration
and tagline. Target at least 65% reduction: at most 140 lines and 800 words,
excluding image URL and code. Prefer short paragraphs, one copyable happy path,
one compact capability map, and links to maintained complementary docs.

Proposed information architecture:

1. **Hero** — existing illustration, project name, tagline, two-sentence purpose.
2. **Why Bebop** — three concise facts: independent Pi Members, project-local
   Crew identity, explicit communication/lifecycle tools.
3. **Install** — one verified current installation path; never claim npm
   publication unless registry proves it.
4. **Start a Crew** — `crew init`, review manifest/instructions, start two roles,
   inspect `/crew members`.
5. **Choose communication** — compact table for Member request, Follow-up,
   Redirect, Inbox, Interrupt, Broadcast; guarantees remain one phrase each.
6. **Boundaries** — Bebop is transport, not workflow; Presence/Activity are not
   availability/progress; Accepted/Persisted/Response are not completion.
7. **Documentation** — task-oriented links.
8. **Development** — minimal install/build/test commands and contribution link
   if one exists.

Move rather than delete unique detail. Existing destinations:

- architecture, layouts, trust, endpoints → `docs/ARCHITECTURE.md`;
- scaffold/manifest instructions → `docs/CREW-INIT.md`;
- CLI flags/results/errors → `docs/CLI-MEMBERSHIP-PARITY.md`;
- status/focus/privacy → `docs/MEMBER-STATUS.md`;
- idle semantics → `docs/MEMBER-IDLE-WAIT.md`;
- request/response workflow → `docs/MEMBER-REQUEST-WORKFLOW.md`;
- lead/product/dev/QA convention → `docs/SOFTWARE-CREW-WORKFLOW.md`.

Add a focused complementary document only when removed information has no
accurate home. Do not duplicate same reference across README and docs.

## Acceptance criteria

- [ ] Tests/checks first capture README links, copyable command snippets, and current size baseline before rewrite.
- [ ] Existing Bebop illustration and “small dysfunctional but effective crew” tagline remain visible at top.
- [ ] First screen explains Pi Bebop in at most two short paragraphs and reaches install/quick start without architecture detail.
- [ ] README is at most 140 lines and 800 words, excluding image URL/code, with no section deeper than `###`.
- [ ] One copyable happy path installs current checkout/package truthfully, initializes `.pi/bebop`, starts at least lead/developer, and shows roster command.
- [ ] Installation instructions are verified from clean consumer context; npm package publication is claimed only if `npm view pi-bebop` succeeds for documented version.
- [ ] README never says both `pi-bebop` and legacy `pi-bebop-cli` are published unless both are independently verified.
- [ ] Capability map uses UL canonical terms and clearly differentiates `send_member_request`, `send_follow_up`, `redirect_member`, `send_to_inbox`, `interrupt_member`, and `broadcast_to_crew` without full schemas.
- [ ] Yielding Request outcome/Member idle behavior reflects current shipped contract after TASK-0075–0077; README does not teach blocking-agent loops or stale tool names.
- [ ] Product boundaries remain explicit: roles are not permissions; online/idle is not availability; Accepted/Persisted/Response is not completion; Bebop has no task/Git/review/CI ownership.
- [ ] Manual manifest JSON, exact field/path/byte limits, full roster sample, full CLI command matrix, exit/error tables, cancellation mechanics, Inbox handoff algorithm, Intake validation, Broadcast idempotency, and release internals leave README and link to authoritative docs.
- [ ] Every removed unique guarantee exists in one linked complementary document or is intentionally retired as obsolete/duplicated; no detail is silently lost.
- [ ] Documentation list is task-oriented and bounded to at most eight links with one-line purposes.
- [ ] All relative links resolve with correct filename/case; all shown commands pass against packaged/local install as documented.
- [ ] README avoids repeated “never means completed” paragraphs by stating one central guarantees/boundaries block and letting feature docs elaborate.
- [ ] Human readability review confirms short paragraphs, scannable headings, no wall-of-text tables, no marketing claims unsupported by tests/registry, and no internal task IDs in reader-facing prose.
- [ ] `git diff --check`, documentation checks, packaged help/install smoke test, and fresh watcher final gate pass.

## Out of scope

- Product behavior, tool/CLI schemas, publication itself, website/gallery copy,
  redesigning complementary docs beyond gaps exposed by extraction, or changing
  illustration asset.

## Verification

- Measure before/after lines and words.
- Validate every link and command from clean consumer/project directories.
- Review against `UL.md` and current tool/CLI help.
- Fresh watcher final gate with unchanged worktree fingerprint.


## Done (13-05)

- Checks first: `scripts/verify-readme.mjs` + `scripts/verify-readme.test.mjs`
  (wired into `npm test` and `make all` as `verify:readme`). Red on the old
  README (13 failures), green on the new one.
- README: 419 lines / 2,301 words -> 119 lines / 596 words (contract
  <=140/<=800); hero illustration + tagline kept; one copyable happy path
  (crew init -> two `--crew-role` sessions -> `/crew members`); capability
  table for all six tools with one-phrase guarantees; central boundaries
  block; yielding-wait semantics from TASK-0075-77; task-oriented docs list
  (7 links, one-line purposes); no task IDs, no `####` headings.
- Verified authority: `npm view pi-bebop` / `pi-bebop-cli` both 404 -> removed
  the false "published to npm / legacy package name" claims; install is local
  only (npm link or tarball), smoke-tested from a clean consumer context
  (pack -> install -> help exit 0 -> crew init layout).
- Relocations: docs/CREW-INIT.md (Manual layout: manifest JSON, instructions
  file semantics, descriptions, roster sample), docs/ARCHITECTURE.md (Release
  verification), docs/CLI-MEMBERSHIP-PARITY.md (Ctrl-C cancellation).
- Gates: 891/891 tests; verify-readme OK; git diff --check clean;
  watcher @agent-final PASS gen=1354 (make all incl. verify-readme).
