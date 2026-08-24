---
id: TASK-0055
title: Select startup crew member by role
status: doing
depends_on: []
priority: normal
tags: [crew, cli, startup, tdd]
---

# Select startup crew member by role

## Problem
Starting a Bebop member requires copying a long project socket path even though the crew manifest already maps roles to endpoints.

## Context

Add `pi --crew-role <role>` as the path-free shorthand for the existing
`pi --crew-socket <path>` startup selection.

Role selection is local to `ctx.cwd`: inspect the supported project manifests
(`.pi/bebop/crew.json`, then compatibility `.pi/crew/crew.json`) only after
project trust is confirmed, resolve one exact role, and delegate to the same
membership join path used by socket selection. Keep `--crew-socket` as the
explicit escape hatch for cross-worktree or external project endpoints.

Treat selection as a small pure domain decision with injected manifest/path IO;
the Pi extension remains the composition root. Do not infer socket filenames
from roles.

## Acceptance criteria

- [ ] Tests first cover one exact role match and prove it joins the manifest-configured socket without filename guessing.
- [ ] `pi --crew-role <role>` starts the control server and activates/persists membership exactly like `--crew-socket`.
- [ ] Role matching is exact and case-sensitive; unknown and duplicate roles fail explicitly and leave the session unjoined.
- [ ] Unknown-role errors include at most the first 8 distinct configured roles in manifest order, omit names and paths, and include exact `omittedRoleCount`; zero configured roles returns an empty list and count 0. Ambiguous-role errors list no members/paths and direct the user to `--crew-socket`.
- [ ] Empty role input fails explicitly; member names are not accepted as roles.
- [ ] `--crew-role` reads only supported manifests beneath trusted `ctx.cwd`; an untrusted project is rejected before manifest IO.
- [ ] Missing supported manifest fails explicitly without starting a partial membership.
- [ ] Canonical and compatibility layouts are supported deterministically; if both manifests exist, startup reports an ambiguity instead of silently choosing one.
- [ ] Supplying both `--crew-role` and `--crew-socket` is a usage error with no join attempt; neither selector silently wins.
- [ ] Existing `--crew`, `--crew-socket`, restored membership, and unjoined startup behavior remain unchanged when `--crew-role` is absent.
- [ ] Extension-loading and startup integration tests cover flag registration, success, every rejection above, and no partial server/membership activation.
- [ ] README, architecture docs, and `crew init` next-command output prefer the concise local form while retaining socket examples for explicit cross-project selection.

## Out of scope

- One-letter aliases, parent-directory manifest search, interactive role prompts, hot reload, role-based authorization, or changing `/crew join <socket>`.

## Verification

- Run focused startup, extension-loading, manifest-selection, and crew-init tests.
- Measure touched-code coverage and inspect change impact for startup selection and generated next-command output.
- Confirm package verification still includes updated runtime/docs assets.

