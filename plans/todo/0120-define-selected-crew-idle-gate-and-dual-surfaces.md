---
id: TASK-0120
title: Define selected Crew Idle Gate and dual surfaces
status: doing
depends_on: [TASK-0116]
priority: high
tags: [crew, idle, command, tools, selection, product, ubiquitous-language, determinism]
---

# Define selected Crew Idle Gate and dual surfaces

## Problem

The accepted Crew Idle Gate contract supports only every other Member through a future agent tool, but Cristian needs both an autonomous Lead tool and `/crew member-idle` with an optional comma-separated exact-Member selection. Selection scope and Pi command lifecycle differ and must be explicit before implementation so neither surface overclaims whole-Crew readiness or lock detection.

## Desired surfaces

```text
wait_for_crew_idle({ members?: ["Dave", "Kelly"], timeout_seconds?: 1800 })

/crew member-idle
/crew member-idle Dave,Kelly
/crew member-idle Mary Jane,Kelly
```

- Omitted `members` means every other configured Member.
- Explicit `members` means only those exact configured Member names.
- Slash-command comma is a separator; surrounding whitespace is ignored. Comma in a configured name is reserved/unsupported for explicit slash selection in v1; omission still includes that Member and the typed tool array can select it exactly.
- Role labels are never accepted as selection because the request is for exact Members and Role is neither identity nor authority.

## Selection contract

1. Resolve from one trusted Membership/manifest snapshot before endpoint IO.
2. Exclude self for omitted selection; reject self in explicit selection.
3. Reject empty segments/array, duplicates, unknown names, unsafe bounds, and malformed command tail atomically before endpoint IO.
4. Normalize a valid selection into manifest order regardless of input order.
5. Freeze normalized targets for the operation. A later manifest edit, Role change, join, restart, or removal never expands or substitutes the set.
6. Results carry request `scope: all | selected`, exact frozen targets, and `coversAllOtherMembers`. Every explicit list remains selected even when complete. `ready/selected` means only the selected Members were all-observed-idle; it must never be rendered as whole-Crew readiness.

Crew Idle Lock remains a whole-Crew blocking-agent claim. Agent `wait-lock` is eligible only when the normalized target set equals every other Member in the frozen manifest, whether selected by omission or by an explicit complete list. A proper subset cannot prove Crew Idle Lock. Slash observation owns no agent marker and never returns `wait-lock`, even with complete selection. Non-eligible cases rely on ready, offline, timeout, unstable, agent message, slash local-activity/lifecycle, or error outcomes. No wait-target graph is exposed to diagnose partial cycles.

## Surface-specific scheduling

Both surfaces reuse one injected selection/final-round orchestration operation, but their caller scheduling is intentionally different:

### Agent tool

- Blocks the current agent run and owns the transient `crew-idle` blocking-wait marker.
- Prevents the Lead auto loop from starting another iteration while pending.
- Accepted Bebop message cancels the gate and returns terminating `message-received`; unchanged message is consumed next under original delivery mode.
- Tool must be called alone/sequentially.

### Slash command

- Is human/operator entered and cannot be called by the model.
- Starts only when current Pi is mechanically idle; if busy/compacting/queued, it fails immediately with actionable guidance rather than silently parking behind the active Lead loop.
- Owns the same single local operation-capacity slot but does not claim an agent blocking-wait marker because an async extension command is not an agent run.
- Performs the same remote selection/status-round logic and appends a bounded TUI-only result; it never enters model context, triggers a turn, or makes the Lead act.
- If local agent activity starts while command waits, command cancels with explicit `local-activity`, releases all subscriptions/capacity, and leaves that activity/message untouched.
- Reload, session replacement, shutdown, and the fixed absolute deadline cancel it deterministically. Pi command context usually has no active `ctx.signal`, so the adapter owns its AbortController and lifecycle cleanup.

Shared semantic outcomes must match where applicable (`ready`, `offline`, `timeout`, `unstable`, errors). Surface-only scheduling outcomes must remain explicit rather than being forced into false parity.

## Acceptance criteria

- [x] `docs/CREW-IDLE-GATE.md` and `UL.md` define optional selection, `scope: all|selected`, both public surfaces, and their scheduling distinction.
- [x] Omitted selection resolves every other frozen manifest Member with `scope=all`; every explicit tool/slash list uses `scope=selected`, resolves exact names only, normalizes into manifest order, and records `coversAllOtherMembers` separately.
- [x] Tool array/slash bounds are exact (32 names, 256 bytes/name, 4,096-byte slash tail); empty, duplicate, self, unknown, Role-fallback, malformed, and oversized selections reject before endpoint IO without partial waiting.
- [x] Slash grammar covers comma-separated names with surrounding whitespace, names containing spaces, trailing/doubled commas, and the explicit v1 comma-in-name limitation.
- [x] `ready/selected` cannot be rendered or interpreted as whole-Crew ready; result includes exact scope and frozen targets.
- [x] Crew Idle Lock is eligible only for the blocking agent tool when normalized selection covers every other frozen Member; an explicit complete agent list remains eligible, while a proper subset and every slash observation never produce `wait-lock`.
- [x] Agent tool retains blocking-run, auto-loop, solitary-call, and accepted-message termination semantics from TASK-0116/TASK-0089.
- [x] Slash command is characterized from Pi 0.84.3: commands bypass model input, command context has `waitForIdle()` but usually no active `ctx.signal` while idle, and async command execution does not itself prove agent Activity busy.
- [x] Busy local session rejects slash start; later local activity cancels command only, without consuming/reordering messages or changing the agent run.
- [x] Slash result is bounded TUI-only state, owns no Blocking-wait marker, and never triggers a model turn, consumes a message, performs Lead action, or grants operator/Role authority.
- [x] Both surfaces share target/status/deadline/round behavior through injected orchestration rather than duplicate business rules.
- [x] One local Member Idle Wait, Crew agent gate, or Crew slash observation occupies operation capacity; concurrent attempts reject before remote IO and cannot replace/clear owner.
- [x] Deterministic matrix covers omitted/explicit/full/subset selection, reordered names, parser boundaries, one-Member Crew, full-selection lock, subset waiting, local busy/activity, inbound message, reload/shutdown, and surface parity/non-parity.

## Acceptance evidence

- Amended normative contract: `docs/CREW-IDLE-GATE.md`.
- Updated canonical definitions, relationships, verb, and ambiguity boundaries: `UL.md`.
- QA matrix: `.tmp/reports/27-08-26/task-0120-selected-crew-idle-gate-acceptance-matrix.md` — ACCEPT, product/docs only.
- TASK-0118/0119/0121 handoffs explicitly preserve scope/coverage, agent-only lock, slash no-marker, and scheduling non-parity.
- Contract checks preserve 63 unrelated UL rows, amend two idle terms, and verify nine deterministic behavior groups; focused formatting/diff checks pass.

## Non-goals

- Standalone `pi-bebop` CLI parity, Role selectors, glob/pattern selectors, persistent watches, automatic Lead action, automatic recovery, remote mutation, comma-bearing slash-selected names, or mathematical atomic-snapshot guarantees.
