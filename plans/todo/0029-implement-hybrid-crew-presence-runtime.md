---
id: TASK-0029
title: Implement hybrid crew presence runtime
status: todo
depends_on: [TASK-0024, TASK-0028]
priority: high
tags: [crew, presence, runtime, json-rpc]
---

# Implement hybrid crew presence runtime

## Problem
Explicit join/leave broadcasts alone miss crashes, while polling alone delays normal transitions; crew members need immediate best-effort updates plus deterministic reconciliation of actual endpoint liveness.

## Context

Combine two signals through TASK-0028's reducer:

1. **Immediate hint:** after explicit join/leave, best-effort JSON-RPC requests tell configured peers to recheck the changed member.
2. **Reconciliation:** a fixed periodic scan probes configured endpoints to detect crashes, missed hints, and stale links.

Add a schema-validated TASK-0024 method such as `crew.presence.hint`:

```json
{
  "member": { "name": "Bob", "role": "dev" },
  "state": "online",
  "instanceId": "session-id"
}
```

The request is claimed/unverified. Receiver resolves the member against its active local manifest and schedules an immediate endpoint probe; unknown/self/mismatched members do not directly alter presence. Acknowledgement only means the hint was accepted.

Use fixed named runtime constants initially (recommended: 5-second reconciliation, 500ms probe/broadcast timeout, two failed observations). Do not expose timing knobs in config yet.

## Lifecycle ordering

- Join/restore: claim member endpoint → start observer → complete initial scan → broadcast online hint.
- Explicit leave: retain manifest snapshot → release own endpoint → broadcast offline hint → stop observer.
- Shutdown: best-effort release/broadcast/cleanup; failures never prevent base cleanup.
- Crash/SIGKILL: peers detect departure through reconciliation.
- Role switch: old endpoint leaves before new endpoint joins, preserving both effects.

## Implementation approach

1. Write runtime tests with injected probe, scheduler, RPC sender, reducer, and effect callback; no real sleeps.
2. Implement one observer owner in the membership/control composition root with explicit start/stop and generation identity to reject stale async completions.
3. Probe non-current endpoints concurrently with bounded timeout, then feed ordered results into the reducer.
4. Broadcast hints concurrently and best-effort; one offline/slow peer must not fail join, leave, restore, switch, or shutdown.
5. Add the presence method schema/handler/client through TASK-0024's shared protocol definitions—no raw envelopes in runtime code.
6. Ensure all timers, pending probes, and handlers are cancelled or ignored after leave, stop, reload, or shutdown.

## Acceptance criteria

- [ ] Joined members complete one initial scan and provide one ordered roster effect; current endpoint is never probed.
- [ ] Explicit join and leave produce bounded parallel hints to other configured endpoints with no self-send.
- [ ] Receiver validates hint schema, active membership, known member name/role, and instance shape before scheduling a probe; hint alone never marks online/offline.
- [ ] Reconciliation detects a crashed/stale member and emits left after the reducer threshold without requiring explicit broadcast.
- [ ] Missed join hint is recovered by periodic reconciliation; duplicate hints/scans do not duplicate effects.
- [ ] A transient probe failure does not emit left; subsequent success silently recovers.
- [ ] Probe and hint completion order cannot reorder roster/effects or mutate a newer observer generation.
- [ ] Leave, role switch, restore, reload, stop, and shutdown clean timers/listeners and ignore stale in-flight work.
- [ ] Broadcast/probe timeout, rejection, parse error, and offline peers are isolated; presence failures never fail membership lifecycle or base cleanup.
- [ ] `presence.notifications: false` creates no observer, timer, hints, probes, or effects.
- [ ] Runtime never exposes global UUID socket paths and treats wire member/instance fields as claimed attribution.
- [ ] Deterministic runtime, lifecycle, crash, concurrency, cleanup, and protocol integration tests pass, followed by coverage/risk analysis and final watcher gate.

## Out of scope

- Central presence server, durable registry, leases, or cross-machine transport.
- `fs.watch` as an authoritative signal.
- User-configurable intervals/thresholds.
- Authenticating presence hints.

