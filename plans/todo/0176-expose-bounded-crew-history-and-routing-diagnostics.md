---
id: TASK-0176
title: Expose bounded Crew history and routing diagnostics
status: todo
depends_on: [TASK-0175]
priority: normal
tags: [cli, crew, history, freshness, diagnostics, privacy, tdd]
---

# Expose bounded Crew history and routing diagnostics

## Problem

Fresh Crew reports need enough history for change detection, while hidden transport routing still needs an explicit diagnostic escape hatch. Default output must stay product-facing and private without making failures impossible to investigate.

## User story

As a Crew coordinator, I want bounded history and opt-in routing diagnostics so that I can compare recent reports and troubleshoot a route without exposing transport internals during normal use.

## Acceptance criteria

- [ ] The approved command surface returns a bounded number/time window of prior Crew reports with explicit captured time, source provenance, age, and partial-result markers.
- [ ] History ordering, retention, size limits, cleanup, and behavior across restart are deterministic and documented before persistence is chosen.
- [ ] Historical Member-reported values remain labelled historical and are never substituted for unavailable current status without explicit user selection.
- [ ] Default `crew list`, `ask`, and `crew status` output remains free of session IDs, aliases, sockets, endpoint paths, capabilities, and Request IDs.
- [ ] One explicit diagnostic flag/view may expose the minimum safe routing evidence needed to identify candidate choice and failed phase; it never exposes capabilities, message content, hidden instructions, or raw dependency output.
- [ ] Diagnostic output clearly distinguishes Crew/Member product identity from Pi session/runtime socket transport identity.
- [ ] Text, TOON, and JSON views are bounded, deterministic, and redact the same fields; unsupported combinations fail before IO with a corrected command.
- [ ] Tests cover retention boundary, empty history, partial history, clock determinism, restart, redaction, debug opt-in, malformed persistence, and cleanup failure.
- [ ] README troubleshooting starts with product commands and relegates sessions/sockets to the explicit diagnostic section.
- [ ] Package verification proves normal examples never require or reveal a session ID or socket.

## Non-goals

Full transcripts, audit logging, analytics, unbounded storage, secret export, live monitoring, or treating old reports as current truth.
