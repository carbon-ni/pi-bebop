---
id: TASK-0101
title: Split CLI default output formats by audience
status: done
depends_on: []
priority: high
tags: []
---

# Split CLI default output formats by audience

## Problem
The pi-bebop CLI hardcodes toon as the default output format for every command, but humans initializing crews (pi-bebop home, crew init, crew roles, session list, member interrupt) get machine notation by default and must know to pass --format text. The home screen does not even accept --format. Humans don't read help text; agents do - so the discovery cost asymmetry means the default should flip for the human-facing set.

## Context
Agreed classification (session 13-04-26, with Cristian). Audience is determined by *who consumes stdout and what decision it feeds*:

**Human set (text default)** - setup/navigation/operator; no agent-tool twin:
- `pi-bebop` (home) - "what command next"
- `crew init` - one-time scaffolding
- `crew roles` - "which role do I boot as"
- `session list` - picking a --session value (agents have list_sessions)
- `member interrupt` - break-glass operator action (weakest call; receipt-shaped but operator purpose)

**Machine set (toon default, unchanged)** - scripts/adapters/CI boundary; every one has an agent-tool twin:
- `send`, `member follow-up`, `member redirect`, `member inbox send`, `crew broadcast`, `member status`, `member wait-idle`

Implementation notes: defaults live in `src/cli/errors.ts` `requestedFormat` (global fallback) and per-command `.option("--format", ..., default)` in `src/cli/commands/*.ts`. Home currently rejects `--format` entirely ("Invalid command '--format'") and must gain the flag. `--format toon|json|text` stays available everywhere; only the default changes per set.

## Acceptance criteria
- [ ] Human set defaults to `text`; machine set keeps `toon`; every command (incl. home) accepts explicit `--format toon|json|text` and honors it.
- [ ] `--format` validation errors are identical across both sets (same message shape as today).
- [ ] Audited: `src/cli/commands/crew-intake-adapter.ts`, `direct-send-adapter.ts`, and `src/application/external-intake.ts` either pass explicit format or are proven unaffected; no silent byte change for scripted consumers.
- [ ] Help text updated per command: "text (default)" / "toon (default)" matches actual behavior.
- [ ] TDD: for each command - default output, explicit override each direction (text default commands prove `--format toon` round-trips and vice versa), and error paths. All `npm test` + lint green.

## Non-goals
- No environment-aware defaults (PI_SESSION_ID detection) - revisit only if agents complain about typing --toon.
- No renderer/content changes - same information, different serialization default.
- No new formats (yaml, table).

## Notes

