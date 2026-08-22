---
id: TASK-0021
title: Document crew getting started
status: done
depends_on: [TASK-0015]
priority: normal
tags: [intray, crew, docs, onboarding]
---

# Document crew getting started

## Problem
The crew workflow introduces manifests, member endpoints, role adoption, and two messaging tools; without one copy-paste path, a new user cannot confidently reach their first successful member message.

## Context
Add an onboarding-first guide after final integration has fixed behavior. Keep README concise and link to focused detail if needed. Document current crew workflow only—removed direct pairing commands and tools must not return as migration guidance.

## Acceptance criteria
- [x] README has a prominent “Crew Getting Started” section that reaches a first successful role-based message without requiring prior intray knowledge.
- [x] Guide provides copy-paste commands to create `.pi/intray/sockets/` and a valid v1 `.pi/intray/crew.json` with lead, developer, and QA members.
- [x] Guide shows startup role adoption with `--intray-socket` and running-session adoption with `/intray join <socket>`.
- [x] Guide explains `/intray status`, `/intray list`, `/intray leave`, and `/intray stop` with expected outcomes.
- [x] Guide shows agent-facing `send_to_member` and explicit `send_to_session({ socketPath })` examples, including synchronous versus callback behavior.
- [x] Guide explains project trust, live-foreign endpoint rejection, stale endpoint recovery, branch-aware restore, and global UUID sockets as internal transport.
- [x] Manifest field reference covers version, member name, role, relative socket under `sockets/`, and optional instructions.
- [x] Examples use only current command/tool/config names, including `startByDefault`; removed pairing/listening APIs are absent.
- [x] Documentation commands and JSON examples are validated mechanically where practical, links resolve, and final watcher gate passes.
