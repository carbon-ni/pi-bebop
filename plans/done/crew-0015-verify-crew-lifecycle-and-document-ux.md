---
id: TASK-0015
title: Verify crew lifecycle and document user flow
status: done
depends_on: [TASK-0010, TASK-0011, TASK-0012, TASK-0013, TASK-0014, TASK-0016, TASK-0017, TASK-0018, TASK-0019]
priority: normal
tags: [intray, crew, integration, docs]
---

# Verify crew lifecycle and document user flow

## Problem
Crew features cross manifest, endpoint, runtime, context, and tool boundaries; without integration coverage, stale identities or leaked sockets can survive lifecycle events.

## Context
Close feature with deterministic end-to-end tests and concise documentation for startup adoption, runtime adoption, direct path targeting, and multi-member messaging.

## Acceptance criteria
- [x] Integration tests create temporary `.pi/intray/crew.json` with lead, developer, and QA endpoints.
- [x] Tests verify startup join and runtime join/leave across reload, new, resume, fork, and shutdown cleanup.
- [x] Tests verify one lead/orchestrator remains the lead and successfully messages both developer and QA by role with no one-peer connection code remaining.
- [x] Tests verify foreign live endpoints are never stolen and stale endpoints are cleaned.
- [x] README documents canonical `.pi/intray` layout, manifest schema, `--intray-socket`, join/leave, `send_to_session` socket-path targeting, and `send_to_member`.
- [x] Closest `AGENTS.md` documents stable crew concepts and lifecycle ownership.
- [x] Localized tests, lint, coverage/risk checks, and final watcher gate pass with unchanged worktree fingerprint.
