---
id: TASK-0247
title: Share SDK explicit hard Interrupt capability
status: todo
depends_on: [TASK-0246]
priority: normal
tags: [sdk, interrupt, recovery, tdd]
---

# Share hard Interrupt

## Problem

Emergency abort/recovery is a high-risk operation that needs one runtime policy rather than edge-specific implementations.

## Desired outcome

CLI and Pi use a distinct SDK Interrupt capability backed by the existing runtime flow.

## Acceptance criteria

- [ ] Preserve current abort/recovery sequencing, authority and online-target requirements through both adapters.
- [ ] Best-effort abort is never described as rollback or guaranteed tool termination.
- [ ] No hidden retries, downgrade to Redirect or effects before validation.
- [ ] Tests cover active work, failed abort, disconnect during dispatch, cancellation, offline target and recovery-message ordering.
- [ ] Pi lifecycle hooks remain injected at the Pi edge; no source self-RPC or shared-state duplication.
- [ ] Packed consumers and exact-head gates pass.

## Non-goals

Process killing, rollback, or new interruption authority. Follow `docs/SDK-REFACTOR.md`.
