---
id: TASK-0133
title: Add crew name as a display label in the manifest
status: todo
depends_on: []
priority: normal
tags: [crew, identity, manifest, ubiquitous-language]
---

## Problem

Receipts, the status footer, and intake messages identify the crew only by filesystem path or nothing at all; humans reading them get no memorable identity. The name is a LABEL, never an address: addressing stays manifest-path based (rotation and relocation are already handled by the manifest file itself).

## Scope

- Optional `name` in crew manifest v1, backward compatible; absent name keeps all current output.
- Surfaces: `/crew members`, `/crew status`, status footer pairing, intake receipts.
- `intake.contact` unchanged: routing policy behind the manifest.

## Acceptance

- Happy: named manifest surfaces label everywhere listed; unnamed manifest is byte-compatible with today.
- Unhappy: invalid name rejected at load with clear error; no surface falls back to guessing.
- Deterministic tests, both paths.
