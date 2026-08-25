---
id: TASK-0084
title: Pick crew role from bare startup flag
status: todo
depends_on: [TASK-0083]
priority: normal
tags: [crew, startup, picker, tui, membership, tdd]
---

# Pick crew role from bare startup flag

## Problem
Starting a crew member still requires remembering and typing an exact role even when the trusted project manifest already contains the selectable roles.

## Context

After TASK-0083 lands, declare `--crew-role` as an optional-value string flag:

- omitted: keep current unselected startup behavior;
- `--crew-role <role>`: keep current exact-role selection;
- bare `--crew-role`: load the trusted current-project manifest and ask the user
  to choose a uniquely selectable role with `ctx.ui.select`.

Keep `src/extension.ts` as composition and startup wiring only. Put picker
orchestration under `src/pi/`, derive deterministic options in pure domain code,
and delegate the selected value to the existing trusted role resolver and
membership join flow. Do not infer sockets from role names.

## Acceptance criteria

- [ ] Tests are written first for valued, bare, omitted, selected, cancelled, and unavailable-picker paths.
- [ ] In a UI-capable startup, bare `pi --crew-role` opens one role picker before any control server or membership side effect.
- [ ] Picker options contain only roles that resolve to exactly one manifest member, preserve first-manifest-appearance order, and expose no names, instructions, or socket paths.
- [ ] Selecting a role delegates to the existing exact trusted role-selection/join path and produces the same membership, persistence, tools, presence, and instructions as `--crew-role <selected-role>`.
- [ ] Escape/cancel leaves the session unjoined, keeps membership tools inactive, and starts no partial socket/server/presence lifecycle.
- [ ] Missing, malformed, unsupported-version, unsafe, untrusted, dual-layout-ambiguous, or zero-selectable-role manifests fail explicitly without opening an empty picker or creating side effects.
- [ ] Bare `--crew-role` in print/JSON/no-UI mode fails explicitly and deterministically; it never chooses a default role or waits for input. RPC uses Pi's supported dialog protocol when `ctx.hasUI` is true.
- [ ] A supplied role remains exact and case-sensitive and does not open UI; existing unknown, empty, and duplicate-role errors remain unchanged.
- [ ] `--crew-role` remains mutually exclusive with a non-empty `--crew-socket`; the conflict fails before manifest loading, picker display, or server startup.
- [ ] Omitted `--crew-role` remains distinguishable from bare and preserves existing `--crew`, socket, restored membership, reload/resume/fork, and unjoined startup behavior.
- [ ] Extension loading, startup integration, cancellation, mode, and lifecycle tests prove no duplicate picker or join occurs across supported session events.
- [ ] Help and README document valued and interactive forms and direct automation to the valued form.

## Out of scope

- Free-text/custom picker entries, fuzzy role matching, member-name selection,
  role authorization, socket inference, or changing ambiguous-role semantics.

## Verification

- Run focused role-domain, startup selection, extension-loading, lifecycle, mode,
  and documentation/package tests.
- Measure touched-code coverage and inspect change impact around startup selection,
  manifest resolution, and membership lifecycle.

## Notes

Use built-in `ctx.ui.select`; a custom TUI component is not justified for a
single ordered list. TASK-0082 may provide reusable role projection, but picker
options must exclude ambiguous roles because they cannot be selected by
`--crew-role`.

