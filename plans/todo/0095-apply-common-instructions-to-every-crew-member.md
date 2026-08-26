---
id: TASK-0095
title: Apply common instructions to every crew member
status: todo
depends_on: []
priority: high
tags: [crew, manifest, instructions, system-prompt, security, scaffold, tdd]
---

# Apply common instructions to every crew member

## Problem
Operators must currently duplicate team-wide guidance across every member role file. Copies drift, and joining members can receive inconsistent collaboration rules even though they belong to the same manifest-defined crew.

## Desired outcome
A crew manifest can declare one common Markdown instruction file that is loaded for every member in addition to that member's role instructions. Existing project-wide `AGENTS.md` guidance and member-specific responsibilities remain separate concepts.

## Product contract
A version 2 manifest declares the optional root field:

```json
{
  "version": 2,
  "commonInstructionsFile": "instructions/common.md",
  "members": [
    {
      "name": "Dave",
      "role": "dev",
      "socket": "sockets/dev.sock",
      "instructionsFile": "instructions/developer.md"
    }
  ]
}
```

The member's system context presents clearly labelled sections in this order:

1. common crew instructions;
2. current member's role instructions.

Both are instructions. Ordering exists for readability and specialization; it does not make role instructions an override mechanism.

## Acceptance criteria
- [ ] Tests first cover parsing, trusted file loading, prompt composition, lifecycle reload, scaffolding, packaging, and failure paths before implementation.
- [ ] Version 2 accepts an optional non-empty relative `commonInstructionsFile` rooted strictly beneath the active layout's `instructions/` directory.
- [ ] Existing version 1 manifests remain accepted byte-compatibly. A runtime that only understands version 1 rejects version 2 explicitly rather than silently ignoring common instructions.
- [ ] Each joined member receives the same exact common instruction content, including a member with no role instructions.
- [ ] A member with both instruction sources receives exactly one labelled common section followed by exactly one labelled role section; startup, restore, and repeated prompt hooks never duplicate either section.
- [ ] Startup, explicit join, and restore load a stable snapshot. Editing either file does not mutate an active member; leave and rejoin reload both files together.
- [ ] Missing, unreadable, directory, symlink-escaped, invalid UTF-8, NUL-containing, blank, oversized, or concurrently changed common files fail closed with an actionable error naming `commonInstructionsFile`.
- [ ] Common and role files are independently bounded to 64 KiB and use the same trusted project/layout and time-of-check/time-of-use protections.
- [ ] A manifest without `commonInstructionsFile` retains existing role-only behavior and output.
- [ ] Common content is never exposed by status lines, roster/member discovery, presence, tools, CLI structured results, logs, or message payloads.
- [ ] `pi-bebop crew init` deterministically scaffolds a version 2 manifest plus `instructions/common.md`; exact rerun remains a byte-identical no-op and conflicts remain atomic.
- [ ] Documentation explains the boundary: `AGENTS.md` is project-wide agent guidance, `common.md` is shared crew collaboration guidance, and member instruction files define role-specific responsibilities.
- [ ] Focused happy/unhappy tests, typecheck, lint, package verification, and watcher final gate pass.

## Non-goals
- Multiple common files, include directives, inheritance, templating, or semantic conflict detection.
- Inline common instructions in the manifest.
- Hot reload or changing the instructions of already-active sessions.
- Replacing `AGENTS.md`, member role instructions, message instructions, or Pi's instruction precedence.
- Exposing instruction content through crew discovery or status surfaces.

## Ubiquitous language
- **Common instructions**: manifest-selected guidance applied to every member of one crew.
- **Role instructions**: member-selected guidance applied only to that member's role.
- **Project guidance**: repository `AGENTS.md` guidance, independent of crew membership.

