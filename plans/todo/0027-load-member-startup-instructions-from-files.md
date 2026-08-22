---
id: TASK-0027
title: Load member startup instructions from files
status: todo
depends_on: [TASK-0022]
priority: high
tags: [crew, instructions, manifest, security]
---

# Load member startup instructions from files

## Problem
Crew member instructions currently must be embedded as one JSON string, making substantial role guidance hard to read, review, and maintain alongside normal Markdown documentation.

## Context

Add an optional `instructionsFile` member field:

```json
{
  "version": 1,
  "members": [
    {
      "name": "Bob",
      "role": "dev",
      "socket": "sockets/dev.sock",
      "instructionsFile": "instructions/dev.md"
    }
  ]
}
```

Paths are relative to the manifest and must stay under its dedicated `instructions/` directory:

- `.pi/bebop/crew.json` → `.pi/bebop/instructions/*`
- `.pi/crew/crew.json` → `.pi/crew/instructions/*`

Keep one obvious source per member: inline `instructions` and `instructionsFile` are mutually exclusive. Existing inline instructions remain supported unchanged.

Load file content when trusted membership is joined or restored. Store the resolved instruction snapshot in membership and inject it through the existing `before_agent_start` system-context hook. Do not reread the file before every turn; edits take effect after explicit rejoin or a subsequent startup/restore.

## Implementation approach

1. Write failing domain tests for `instructionsFile` schema, mutual exclusion, path containment, and normalization.
2. Keep lexical field validation pure in the domain manifest parser; perform trusted filesystem resolution and reading in the manifest-store infrastructure boundary.
3. Resolve real paths before reading and reject symlink/directory traversal outside the real crew directory, including an `instructions/` symlink escaping the project crew root.
4. Decode strict UTF-8 with a named byte limit, reject empty/whitespace-only and NUL-containing content, and preserve valid Markdown/newlines as the instruction snapshot.
5. Return field/member-specific manifest errors without leaking instruction contents or raw filesystem stacks.
6. Cover startup selection, persisted restoration, explicit rejoin refresh, inline compatibility, and both supported layouts through integration tests.
7. Document inline and file-backed examples, refresh timing, limits, path rules, and failure recovery.

## Acceptance criteria

- [ ] Manifest schema accepts exactly one optional instruction source per member: non-empty inline `instructions` or relative `instructionsFile`.
- [ ] A member with neither field behaves exactly as today; existing inline instruction parsing and system-prompt injection remain unchanged.
- [ ] `instructionsFile` must resolve beneath the manifest's `instructions/` directory; absolute paths, `..` traversal, sibling directories, NULs, directories, and escaping symlinks are rejected before content injection.
- [ ] Project trust is checked before any manifest or instruction-file IO, and only the active trusted `.pi/bebop` or `.pi/crew` layout from TASK-0022 can load files.
- [ ] Files are strict UTF-8, non-empty after whitespace validation, NUL-free, and bounded by a named deterministic byte limit.
- [ ] Missing, unreadable, invalid-encoding, empty, oversized, and unsafe files fail join/restore with distinct actionable member/field errors and no partial membership claim.
- [ ] Valid Markdown, Unicode, and multiline content is preserved deterministically and injected once through existing `Role instructions:` membership context.
- [ ] Startup and persisted restore load the current file snapshot; an active session does not change when the file changes mid-turn or between turns.
- [ ] Explicit leave/rejoin reloads changed file content, with tests proving old snapshot before rejoin and new snapshot afterward.
- [ ] Multiple members may reference distinct files; one invalid referenced file rejects the manifest atomically rather than creating a partial crew.
- [ ] Error messages and logs never include full instruction contents or raw stack traces.
- [ ] README and architecture docs explain inline versus file-backed configuration, mutual exclusion, trusted path boundary, refresh timing, and both layouts.
- [ ] Domain, infra, membership, startup/restore, security, and unhappy-path tests pass, followed by coverage/risk analysis and the final watcher gate.

## Out of scope

- Nested includes, globbing, remote URLs, environment expansion, or shell interpolation.
- Watching files or hot-reloading instructions into an active turn.
- Combining inline and file-backed instructions for one member.
- Per-message instruction files; TASK-0025 owns per-message context.

