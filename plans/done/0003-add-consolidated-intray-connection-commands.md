---
id: TASK-0003
title: Add consolidated intray connection commands
status: done
depends_on: [TASK-0002]
priority: high
tags: [intray, commands, ux]
---

# Add consolidated intray connection commands

## Problem
Users need token-free slash commands to listen, connect, list, inspect, disconnect, and stop without involving the model.

## Context
Slash commands bypass model and therefore remove discovery/setup token cost.

## Acceptance criteria
- [x] `/intray listen` starts endpoint if needed, enables acceptance idempotently, returns immediately, and updates status.
- [x] `/intray connect <id|name>` reports connected or actionable deterministic failure.
- [x] `/intray list` works while local endpoint is stopped and shows online/listening/connected states using bounded parallel probes.
- [x] `/intray status`, `/intray disconnect`, and `/intray stop` reflect and manage real runtime state.
- [x] Old `/intray start` and `/intray-sessions` paths are removed so command behavior has one obvious surface.
- [x] Commands do not trigger an agent turn merely for setup/status.
- [x] Command parsing/completions and fake-runtime happy/unhappy paths are tested.

## Notes

