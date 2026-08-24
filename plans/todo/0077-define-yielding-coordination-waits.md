---
id: TASK-0077
title: Define yielding coordination waits
status: todo
depends_on: []
priority: high
tags: []
---

# Define yielding coordination waits

## Problem
Agent-facing wait tools keep current Pi run mechanically busy while waiting on another member. Two members can therefore wait on each other through Request outcome or Member Idle Wait until timeout. Waiting must yield current run and resume through one-shot lifecycle delivery instead of holding tool execution open.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

