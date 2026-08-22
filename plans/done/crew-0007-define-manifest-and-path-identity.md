---
id: TASK-0007
title: Define crew manifest and socket path identity
status: done
depends_on: []
priority: high
tags: [intray, crew, domain]
---

# Define crew manifest and socket path identity

## Problem
Crew behavior needs one deterministic source of truth that maps repository-local socket paths to member identity and role without globally unique names.

## Context
Use `<project>/.pi/intray/crew.json` as default location, accessed through Pi's `CONFIG_DIR_NAME`. A selected socket path must identify exactly one configured member. The manifest, not socket filename, is authoritative.

## Acceptance criteria
- [x] Tests first cover valid and invalid manifest versions, members, roles, instructions, and socket paths.
- [x] Manifest parser returns typed crew/member values without IO concerns in domain layer.
- [x] Relative member sockets resolve from manifest directory using lexical absolute normalization, without resolving symlink target.
- [x] Absolute or escaping member socket paths are rejected so endpoints remain under `.pi/intray/sockets/`.
- [x] Reverse lookup returns exactly one member or a typed no-match/duplicate-path error.
- [x] Duplicate member names and duplicate normalized socket paths fail loudly.
- [x] Manifest reads require actual Pi project trust, not only a path named as trusted.
- [x] Domain exports are available through `src/domain/index.ts` only.
