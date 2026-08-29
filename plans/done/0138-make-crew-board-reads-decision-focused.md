---
id: TASK-0138
title: Make Crew Board reads decision-focused
status: done
depends_on: [TASK-0126]
priority: high
tags: [crew, board, tools, agent-output, tokens, privacy, tdd]
---

## Problem

`read_crew_board` serializes the entire canonical store result, exposing storage-integrity fields and empty/default metadata while duplicating the same result in content and details. A reading agent needs only attributed Post content plus conditional continuation or warning signals.

## Product contract

Default agent content is compact text. One Post renders exactly:

```text
#1 [tip] Dave (dev)
TDD evidence discipline ...
```

Posts retain manifest order and use one blank line between entries. Default output contains only sequence, kind, attributed author name/Role, and exact message. References and links appear only when non-empty/present. Pagination guidance appears only when another page exists; corruption/quarantine diagnostics appear only when nonzero or truncated. Empty Board output is one short sentence.

The tool must not expose canonical store objects blindly. Public structured details are a separate compact decision view: they may retain exact `post_id` for explicit `supersedes`/`disputes` actions, but omit schema versions, semantic fingerprints, raw timestamps, redaction bookkeeping, nulls, empty collections, false flags, and zero counters. Application/store contracts remain unchanged.

## Acceptance criteria

- [x] A red test proves current `JSON.stringify(result)` output fails the exact one-Post compact-text contract.
- [x] One Post content is exactly `#<sequence> [<kind>] <name> (<role>)\n<message>`; message bytes and attribution remain unchanged.
- [x] Empty and multi-Post pages are deterministic, compact, and preserve result order with no synthetic ranking or interpretation.
- [x] References/link, continuation cursor/guidance, and corruption/quarantine/truncation warnings appear only when actionable; absent/empty/false/zero values emit no placeholder text.
- [x] Default content omits `version`, `id`, `createdAt`, `semanticFingerprint`, `redactions`, `nextCursor:null`, `hasMore:false`, and zero diagnostic fields.
- [x] Structured details use one bounded public projection, retain exact `post_id` only for linking, and omit all internal/default metadata above; content and details do not each duplicate the canonical store result.
- [x] Error paths keep the existing canonical Actionable Error envelope and do not expose store exceptions or paths.
- [x] `leave_crew_post`, `/crew board`, application/domain/store persistence, cursors, filtering, ordering, and read-only semantics remain unchanged.
- [x] Representative measurement records exact UTF-8 bytes for current JSON, raw TOON, and compact text without claiming universal savings.
- [x] Focused tool tests, format/type/lint/architecture/package checks, and fresh exact-hash watcher gate pass.

## Evidence

- Implementation: `4e37a27`; P1 fix: `3f1ce22`.
- Exact-hash QA PASS at `3f1ce22`: focused Crew Board tests `7/7`, full suite `1,465/1,465`, watcher generation 340, clean diff. Report: `.tmp/reports/13-04-26/task-0138-3f1ce22-final-qa.md`.

## Non-goals

Changing Crew Post semantics, storage schemas, IDs/fingerprints, cursor algorithms, retention/quarantine behavior, Board ranking/search, automatic delivery, or making TOON the default for irregular prose Posts.
