---
id: TASK-0170
title: Add complete human-readable CLI presenters
status: todo
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

- [ ] Every result-producing command has representative text fixtures for happy, empty/no-op, usage-error, operational-error, and truncated/list cases relevant to that command.
- [ ] `session list --format text` shows session identity/aliases/membership and total/omitted state instead of a generic receipt.
- [ ] `crew init` default text reports created/verified state, target, relevant paths, and next command without a structured envelope.
- [ ] Roles, status, idle wait, request lifecycle, Guest lifecycle, and communication receipts expose only decision-relevant facts in stable readable wording.
- [ ] Text presenters consume bounded canonical view models; they do not inspect transports, domain internals, secrets, or raw dependency errors.
- [ ] TOON and JSON remain deterministic semantic equivalents of the canonical structured result and retain truncation metadata.
- [ ] Structured results round-trip through the maintained TOON library; representative UTF-8 byte measurements are recorded without claiming universal savings.
- [ ] Help, README examples, CLI parity documentation, package verification, and snapshots reflect the final defaults and explicit overrides.
- [ ] A guard prevents successful data-only text results from falling through to generic `Message completed`.
- [ ] Full watcher gates, CLI coverage/complexity, packed installation, and unchanged-worktree freshness pass.

## Non-goals

Color, interactive prompts, terminal-width-dependent layouts, progress animation, or removing JSON/TOON opt-ins.
