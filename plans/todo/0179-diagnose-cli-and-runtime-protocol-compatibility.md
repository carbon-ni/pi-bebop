---
id: TASK-0179
title: Diagnose CLI and runtime protocol compatibility
status: todo
depends_on: [TASK-0173]
priority: high
tags: [cli, protocol, version, compatibility, doctor, diagnostics, tdd]
---

# Diagnose CLI and runtime protocol compatibility

## Problem

When CLI and running Bebop versions differ, unsupported RPC methods surface as opaque `method-not-found` errors. Users need an actionable compatibility diagnosis and safe recovery without exposing protocol internals or silently weakening guarantees.

## User story

As a Crew coordinator, I want `pi-bebop doctor` and command errors to explain version incompatibility so that I can recover without understanding JSON-RPC methods or socket topology.

## Acceptance criteria

- [ ] A bounded read-only compatibility exchange exposes protocol/capability information sufficient to distinguish unsupported action, stale runtime, malformed peer, and ordinary transport failure.
- [ ] `pi-bebop doctor` checks CLI build version, discoverable Crew runtimes, required command capabilities, and configuration health without triggering model turns or mutation.
- [ ] Default doctor output uses Crew/Member product identities and hides session IDs, sockets, endpoints, raw method names, capabilities, and credentials unless explicit safe diagnostics are requested.
- [ ] A `method-not-found` response maps to an `incompatible-runtime` product error naming the unavailable feature and an exact update/restart/retry command.
- [ ] No compatibility fallback weakens correlation, durability, ordering, authorization, or privacy. In particular, Member Request never silently falls back to an uncorrelated send.
- [ ] Mixed compatible/incompatible Members produce deterministic partial diagnostics rather than failing all Crew rows.
- [ ] Current, older, newer, missing-version, malformed-version, missing-capability, offline, timeout, and cancellation fixtures are covered without network or registry access.
- [ ] Help documents what doctor checks, timeout/default bounds, and the difference between package version, build commit, and runtime protocol capability.
- [ ] Text default plus explicit TOON/JSON follow the audience/output contract and contain one actionable next step per failure.
- [ ] Packed old/new artifact compatibility tests and final gates pass.

## Non-goals

Automatic package installation, process restart, protocol downgrade, exposing raw topology, or guaranteeing compatibility from SemVer alone.
