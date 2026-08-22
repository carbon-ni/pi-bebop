---
id: TASK-0001
title: Define direct connection domain and protocol
status: done
depends_on: []
priority: high
tags: [intray, domain, protocol]
---

# Define direct connection domain and protocol

## Problem
Intray needs deterministic one-peer pairing and command/protocol rules before runtime behavior can be implemented safely.

## Context
Canonical plan: `/Users/cristianoliveira/.agents/reports/21-08-26/intray-auto-connections-plan.md`.

Use pure rules for one-peer logical pairing over existing request-scoped RPC. Persistent duplex sockets are out of scope.

## Acceptance criteria
- [x] Tests first cover `listen`, `list`, `connect <target>`, `status`, `disconnect`, and `stop` parsing, including invalid arity/actions.
- [x] Pure state rules derive stopped/online/listening/connected and reject self, not-listening, busy, and wrong-peer disconnect paths.
- [x] Same-peer and reciprocal retries converge idempotently under deterministic policy.
- [x] Protocol types include bounded `connect`, `disconnect`, and `status` commands/responses using existing session-id validation.
- [x] Domain remains free of runtime, IO, timers, and infra imports.

## Notes

