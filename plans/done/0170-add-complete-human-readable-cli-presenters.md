---
id: TASK-0170
title: Add complete human-readable CLI presenters
status: done
depends_on: [TASK-0169]
priority: normal
tags: [cli, text, ux, output, docs, tdd]
---

# Add complete human-readable CLI presenters

## Problem

Text rendering currently falls back to generic receipts for data-only results, so explicit text output can hide useful information such as session rows. Every result-producing command needs concise human-readable success, empty, and failure output without weakening structured agent output.

## Desired outcome

Plain text answers a human's next decision directly. It uses command-specific view models, readable labels and rows, and actionable errors; it never dumps internal objects or silently replaces useful data with `Message completed`.

## Acceptance criteria

- [x] Every result-producing command has representative text fixtures for happy, empty/no-op, usage-error, operational-error, and truncated/list cases relevant to that command. (Existing command contract suites plus transport-free presenter fixtures cover these result families.)
- [x] `session list --format text` shows session identity/aliases/membership and total/omitted state instead of a generic receipt.
- [x] `crew init` default text reports created/verified state, target, relevant paths, and next command without a structured envelope.
- [x] Roles, status, idle wait, request lifecycle, Guest lifecycle, and communication receipts expose only decision-relevant facts in stable readable wording.
- [x] Text presenters consume bounded canonical view models; they do not inspect transports, domain internals, secrets, or raw dependency errors.
- [x] TOON and JSON remain deterministic semantic equivalents of the canonical structured result and retain truncation metadata.
- [x] Structured results round-trip through the maintained TOON library; representative UTF-8 byte measurements are recorded without claiming universal savings.
- [x] Help, README examples, CLI parity documentation, package verification, and snapshots reflect the final defaults and explicit overrides.
- [x] A guard prevents successful data-only text results from falling through to generic `Message completed`.
- [x] Full watcher gates pass when the watcher is available; otherwise equivalent direct full-suite, verify:cli, complexity, and packed-installation gates pass with watcher-unavailable evidence and unchanged-worktree freshness. (2026-09-06: Funzzy unavailable after 1000ms, connect ENOENT `.pi/funzzy.sock`; direct `npm test` 1262/1262, `npm run verify:cli` passed twice at 90.42%/90.34% branch coverage, complexity ≤10, packed-installation verification passed, and `git diff --check` passed.)

## Non-goals

Color, interactive prompts, terminal-width-dependent layouts, progress animation, or removing JSON/TOON opt-ins.
