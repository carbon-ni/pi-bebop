---
id: TASK-0219
title: Retry fresh Crew Intake files after quiescence
status: done
depends_on: [TASK-0216]
priority: high
tags: [intake, reliability, tdd]
---

# Retry fresh Crew Intake files after quiescence

## Problem

The live Crew Intake eval proved that an atomic file arrival can trigger one scan before the quiescence window, remain in `intake/new` indefinitely, and never reach the configured contact. Current integration tests call `scan()` explicitly after writing and do not exercise this watcher timing boundary.

## Desired outcome

A valid atomic `.md`/`.txt` arrival progresses after it becomes stable without another filesystem event, unrelated model turn, or manual scan. Retry lifecycle stays bounded, single-flight, deterministic, and cancellable.

## Acceptance criteria

- [x] A test using the real filesystem watcher and default quiescence reproduces atomic rename arriving before stability, then observes one accepted delivery without explicitly calling `scan()` after publication.
- [x] Fresh pending files schedule the earliest necessary delayed rescan; repeated filesystem events do not create unbounded timers or concurrent scans.
- [x] Delivery remains exact-contact and idempotent. The source moves once to `processed/`; no duplicate Follow-up is sent.
- [x] `invalidate()`, membership change, and `close()` cancel pending retries. No delivery or retained timer occurs after close.
- [x] Invalid, failed, or permanently unstable files retain existing bounded failure semantics; retry does not busy-loop.
- [x] The two-agent live online eval processes the published file and shows the Follow-up only in Contact, not Peer.
