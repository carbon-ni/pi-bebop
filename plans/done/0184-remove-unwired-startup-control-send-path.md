---
id: TASK-0184
title: Remove unwired startup control send path
status: done
depends_on: []
priority: normal
tags: [techdebt, pi, dead-code, startup-send]
---

# Remove unwired startup control send path

## Problem

`maybeHandleStartupControlSend` in `src/pi/startup-send.ts` was referenced only by its own definition — no callers, no tests (the architecture review overstated "colocated tests"; none existed). The repo maintained dead behavior and local AGENTS.md documented a false live path.

## Acceptance criteria

- [x] `maybeHandleStartupControlSend` and its tests are deleted — decision: deletion (default). No tests existed to delete; TDD via full-suite green before/after.
- [x] No remaining references; `startup-send.ts` exports only wired code (511 → 353 lines; removed also `parseStartupControlSendOptions`, `StartupControlSendFlags`, `StartupControlSendOptions`, and 5 dead-only imports: `getSocketPath`, `isSocketAlive`, `resolveSessionIdFromAlias`, `isSafeSessionId`, `normalizeMode`, `normalizeWaitUntil`, `RpcSendCommand`, `WaitUntil`).
- [x] `npm test`, `npm run lint` pass. AGENTS.md updated (local doc, gitignored — no false live path remains).

## Evidence

- Code commit: `cc43a20` on `dev-next` (1 insertion, 171 deletions).
- Baseline focused tests green pre-deletion; full suite `npm test` 1196 pass / 0 fail post-deletion (one unrelated socket-test flake observed once, non-reproducing over two reruns).
- `npm run lint` green; `make all` quality gate PASS (watcher gen=947); format:check green after prettier.
- `npm run verify:cli` branch coverage 89.92% vs 90% threshold: **pre-existing failure** — baseline at parent commits fails identically (89.87%); this change improves coverage. Tracked for the CLI coverage gap / TASK-0190 parser work.
- Unblocked: TASK-0187 (extension.ts composition split) no longer risks churn against startup-send wiring; its card notes "land after TASK-0184" — that dependency is now satisfied.
