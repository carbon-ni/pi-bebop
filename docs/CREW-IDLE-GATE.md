# Crew Idle Gate

## Problem

A coordinating Member can wait for one other Member today, but a Lead loop often
needs to pause until every other configured Member has settled before deciding
what to route next. Repeated Member Status calls spend model turns, remember
stale observations, and can act after different Members were idle at different
times. Blocking idle waits can also lock the Crew when every Member is waiting
for another Member to settle.

Bebop needs one bounded, event-driven coordination primitive over every other Member or an explicit exact-Member scope. It must be honest about selected versus whole-Crew observations, release an agent caller from a proven whole-Crew wait lock, and never mutate another Member's run.

## Product surfaces

The same selected-target/final-round operation has two callers with deliberately different scheduling:

```text
wait_for_crew_idle({ members?: ["Dave", "Kelly"], timeout_seconds?: 1800 })

/crew member-idle
/crew member-idle Dave,Kelly
/crew member-idle Mary Jane,Kelly
```

**Crew Idle Gate** is one transient bounded observation over a frozen target scope. Omitted selection means every other configured Member; explicit selection means only exact named Members. Both surfaces require Current Membership. Any Current Member may use them: Lead is a workflow convention, never a permission, and a human command grants no operator authority.

The agent tool blocks the caller's current Pi run, so an automatic caller loop cannot start its next iteration. The human slash command runs outside an agent turn, produces TUI-only output, and never causes Lead action. Neither surface repeatedly calls a model while Bebop observes mechanical state. The caller decides what to do with the result; the gate never routes work itself.

## Selection, frozen target set, and deadline

Selection resolves synchronously from one active trusted Membership/manifest snapshot before endpoint IO. The snapshot freezes the caller, complete manifest-order roster, normalized target set, selection mode, and whether targets cover every other frozen Member.

### Omitted selection

Omitting `members` from the tool or omitting the slash tail selects every other configured Member in manifest order. The caller is excluded because the agent tool makes its run busy and the slash command observes from the caller's local runtime. A one-Member Crew therefore returns `ready/no-other-members` with `scope=all` and zero endpoint IO.

### Explicit selection

The tool accepts one non-empty array of 1–32 exact configured Member names. Each submitted string is 1–256 UTF-8 bytes and is matched byte-for-byte without trimming, Unicode normalization, Role lookup, globbing, or case folding. Self, duplicate, unknown, empty, malformed, or oversized input rejects atomically before endpoint IO. A value equal to a Member name is a name even if it resembles a Role; a Role match without an exact Member-name match is unknown.

The slash command treats a missing/whitespace-only tail as omitted selection. Otherwise it accepts 1–32 comma-separated segments in at most 4,096 UTF-8 bytes. It removes surrounding whitespace from each segment, preserves internal spaces, then performs exact Member-name lookup. Leading, trailing, doubled, or whitespace-only comma segments reject. Quoting/escaping has no special meaning. A configured name containing comma (or requiring leading/trailing whitespace for identity) cannot be explicitly selected through slash v1; omission still includes it and the typed tool array can select it exactly.

Valid explicit input normalizes to frozen manifest order regardless of caller order. `scope` records request mode, not inferred coverage:

- omitted selection -> `scope=all`;
- any explicit list, including a list equal to every other Member -> `scope=selected`.

Every result also carries `coversAllOtherMembers`. It is true only when the normalized set equals every non-caller Member in the frozen roster. Thus explicit complete selection remains honestly labelled selected while lock eligibility can still use exact full-roster coverage. `ready/selected` is never rendered as “Crew ready,” even when `coversAllOtherMembers=true`; it means the exact displayed selected targets were all-observed-idle.

A later manifest edit, join, Role change, removal, or replacement Membership never expands, contracts, reorders, or substitutes the frozen set or changes coverage. Loss/replacement of caller Membership aborts. Frozen-target restart, disappearance, or identity mismatch produces `offline`/protocol error; Bebop never reconnects or substitutes.

After preflight, the caller synchronously acquires the one local idle-observation capacity slot before remote IO. Agent gate, slash observation, and Member Idle Wait share this slot; concurrent attempts reject `wait-in-progress` and cannot replace or clear the owner.

Timeout is one operation-wide monotonic bound: default 1,800 seconds, accepted tool range 60–7,200 whole seconds. Slash v1 exposes no timeout flag and uses the 1,800-second default. Probes, subscriptions, rounds, arbitration, and cleanup consume the same deadline; Member/round count never multiplies it.

## Final status round

A **Final Crew Status Round** is one bounded concurrent query of the Crew Idle Gate's complete frozen target scope—every other Member for `scope=all`, or the explicit normalized targets for `scope=selected`. Each response contains configured name/Role, Presence, Activity, pending-message signal, and its own observation timestamp. Responses are validated against the exact target and normalized back to manifest order; arrival order has no product meaning. “Full round” always means the full frozen target scope, never silently the whole manifest when scope is selected.

The gate returns `ready` only when every target in one completed round reports
`online/idle`:

- `no-other-members` — the target set was empty;
- `initial-round` — the first round observed every target idle;
- `after-wait` — one or more event-driven waits preceded the final round.

A Final Crew Status Round is not an atomic distributed snapshot. Its Member observations occur at different instants, and `ready` means only **all frozen targets observed idle in that round and stated scope**. `ready/selected` makes no claim about unselected Members. Neither scope promises simultaneous/future idleness, an empty pending-message queue, availability, willingness, health, acknowledgement, Response, task completion, progress, or quality.

Prior idle observations never satisfy a later round. If Dave was observed idle,
then Kelly settles, but the next full round observes Dave busy, the gate waits
again instead of returning from remembered state.

## Event-driven rounds

The gate follows this loop without model polling:

1. Run one concurrent Crew Status round.
2. Return `ready` if all frozen targets are `online/idle`.
3. Return `offline` if any frozen target is unreachable.
4. For the agent surface only, return `wait-lock` if full-roster coverage and the exact Crew Idle Lock predicate below are true.
5. Atomically subscribe to idle and blocking-wait transitions for every target
   observed busy or compacting. Subscribe-and-snapshot must not lose a transition
   between the status response and subscription.
6. After every frozen non-idle target produces a terminal idle observation, run a new full frozen-scope status round.

A target already idle at subscription time completes without a lingering listener. Any offline, agent message-wake, slash local-activity, deadline, abort, Membership, lifecycle, protocol, or capacity terminal cancels all remaining probes/subscriptions. Late callbacks perform cleanup only and cannot replace the committed result.

There is no polling interval, sleep, background watcher, automatic retry, or
model-driven status loop. The operation permits at most **32 completed status
rounds**, including the initial round. A ready 32nd round succeeds; a non-ready
32nd round that would require another round returns `unstable`. This finite cap
bounds rapid state churn independently of the wall-clock deadline.

## Crew Idle Lock

A **Crew Idle Lock** remains a whole-Crew, agent-run claim. It is proven only when one coherent observation establishes:

1. the surface is the blocking agent tool and caller owns its active `crew-idle` marker;
2. `coversAllOtherMembers=true` for the frozen roster (omitted selection or explicit complete list);
3. the non-empty frozen target set contains no offline or unknown target;
4. every frozen target currently owns an explicit blocking-wait marker of `member-idle` or `crew-idle`.

Generic `busy` or `compacting` Activity is never lock evidence. Bebop does not
inspect conversation, work, task state, tool arguments, or wait targets to infer
a lock.

The blocking-wait marker is transient mechanical state. A peer may observe only
configured name/Role, wait kind, and observation time. It exposes no target name,
message, prompt, instructions, tool arguments, session ID, path, model data, or
inferred intent. It is acquired before remote wait IO and cleared exactly once
before the caller continues, including error, reload, and shutdown paths. It is
not persisted as Member history.

When Crew Idle Lock is proven, the gate:

1. commits caller-local `wait-lock`;
2. cancels only the caller's outstanding status/wait subscriptions;
3. clears only the caller's `crew-idle` marker;
4. resumes the caller with the manifest-ordered blocking Member observations.

It does **not** cancel, abort, interrupt, redirect, message, mark idle, or assign
any remote Member. It does not choose a recovery action. In an all-gates lock,
more than one caller may independently observe the predicate and release its own
gate; no Role selects a privileged winner.

A proper selected subset never produces `wait-lock`, even when every selected target is waiting. It remains non-ready until selected targets settle or offline/timeout/unstable/message/error releases the agent gate. Wait-target identity stays private; Bebop does not diagnose a partial hidden dependency cycle.

The slash command never owns an agent `crew-idle` marker, never participates in Crew Idle Lock, and never returns `wait-lock`. Even with full-roster selection it is an idle human observation, not a blocked Crew agent. Remote blocking markers remain ordinary non-ready mechanical state until readiness, local activity, offline, timeout, unstable, lifecycle cancellation, or error.

## Surface scheduling and cancellation

Both adapters call one Pi-agnostic injected orchestration operation for selection, frozen targets, concurrent status/wait rounds, deadline, round cap, ordering, and shared outcomes. Surface policy supplies only caller-local arbitration/wake/cancellation behavior; neither adapter reimplements target business rules.

### Agent tool

- The tool blocks the current agent run, owns the transient `crew-idle` marker, and keeps pi-auto from starting another iteration while pending.
- It arms accepted-message wake before remote IO under TASK-0089. Accepted Follow-up, Redirect, Request, Response, Inbox handoff, or Broadcast releases the gate as terminating `message-received`; the exact unchanged message becomes next model context under original delivery mode.
- It must be called alone/sequentially. The tool result contains no message body/instructions/Origin.
- Caller abort, Membership loss, reload, replacement, and shutdown cancel every remote operation and marker exactly once.

### Human slash command

- `/crew member-idle` is human-entered extension command syntax and is never an agent-callable tool.
- Start uses one atomic local-runtime boundary: validate mechanically idle (not agent busy, compacting, or queued-to-run), arm local-activity/lifecycle cancellation, acquire the shared capacity slot, then revalidate idle before endpoint IO. Any failed/rechecked state returns actionable `local-busy` without remote IO.
- Pi 0.84.3 command handling bypasses ordinary model input. Command context exposes `waitForIdle()`, but this command deliberately does not park behind a busy run; idle command contexts usually have no active `ctx.signal`, and async command execution does not itself prove agent Activity busy. The adapter therefore owns an AbortController wired to runtime activity, reload, session replacement, and shutdown.
- If local agent activity starts while waiting—including normal handling of an accepted Bebop message—the command commits `local-activity`, aborts only its own probes/subscriptions, releases capacity, and leaves the activity/message untouched in original queue/mode/order. It never consumes or transforms a message.
- A bounded result is rendered through TUI-only command UI/custom data excluded from model context. The command never sends a user/custom model message, invokes a provider, starts a turn, or makes Lead act.
- On reload/session replacement/shutdown, cleanup is mandatory; render `cancelled/<reason>` only if the originating UI context remains valid. Never write stale UI/session state.
- The command owns no Blocking-wait marker and has no `message-received` or `wait-lock` outcome.

At the same local slash boundary, `local-activity` wins over mechanical ready/offline/unstable/timeout so a newly active run is never preceded by a misleading command claim. A terminal already committed before later activity remains an honest momentary result.

## Closed terminal outcomes

| Outcome            | Surface    | Meaning                                                                                    | Continuation                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `ready`            | both       | One final round observed every frozen target `online/idle` in stated scope.                | Agent continues normally; slash renders TUI-only. Caller chooses action.           |
| `wait-lock`        | agent only | Full-roster exact Crew Idle Lock predicate was observed.                                   | Ordinary agent continuation; caller chooses recovery.                              |
| `offline`          | both       | One or more frozen targets became unreachable. Offline is not idle.                        | Bounded manifest-order blockers; no reconnect.                                     |
| `timeout`          | both       | Absolute deadline expired before another terminal committed.                               | Bounded last observations.                                                         |
| `unstable`         | both       | Non-ready round 32 would require another round.                                            | Bounded last observations.                                                         |
| `message-received` | agent only | Bebop message accepted while blocking tool was pending.                                    | Terminating tool result; unchanged message is next model context in original mode. |
| `local-busy`       | slash only | Local Pi was busy/compacting/queued at start or atomic recheck.                            | Immediate actionable TUI result; zero endpoint IO.                                 |
| `local-activity`   | slash only | Local agent activity started while command observed.                                       | Cancel command only; original activity/message continues untouched.                |
| `cancelled`        | slash only | Reload, session replacement, or shutdown cancelled observation.                            | Cleanup; render reason only while originating UI remains valid.                    |
| error              | both       | Membership, malformed/foreign response, capacity, transport, parser, or lifecycle failure. | Error after complete caller-local cleanup.                                         |

Every post-selection result is closed and bounded: `surface=agent|slash`, `scope=all|selected`, `coversAllOtherMembers`, exact frozen targets (maximum 32, manifest order), mechanical outcome/observations, per-Member timestamps, completed rounds, and round-completion timestamp. Preflight selection/local-busy errors contain no partial target observations. Results contain no message body, instructions, Origin, wait target, conversation, session/socket/path/model data, or inferred intent.

## Race ownership

One caller-local arbiter owns the terminal. Otherwise first validated terminal wins, with these same-boundary priorities:

```text
agent: message-received > wait-lock > ready > offline > unstable > timeout
slash: local-activity > ready > offline > unstable > timeout
```

Priority resolves only candidates observed at the same boundary; it never reorders later events. Agent abort/Membership loss cancels immediately unless a message was already accepted and must be drained. Slash lifecycle cancellation cancels its observer immediately and never consumes activity. After commit, every later timer/socket/status/marker/subscription callback is cleanup-only and cannot replace result.

Exactly one local Member Idle Wait, agent Crew Idle Gate, or slash Crew observation may own capacity. A second attempt rejects `wait-in-progress` before remote IO and cannot share, replace, or clear the first owner. Agent tool must be called alone/sequentially because `message-received` terminates the content-free continuation; slash command is awaited by its human command handler, not an agent tool call.

## Decision table

| Scenario                                                                       | Required result                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Omitted selection, multiple Members                                            | `scope=all`; every other frozen roster Member targeted in manifest order.                        |
| Explicit `Kelly,Dave`, manifest order Dave/Kelly                               | `scope=selected`; targets normalize Dave/Kelly.                                                  |
| Explicit list equals every other Member                                        | `scope=selected`, `coversAllOtherMembers=true`; selected ready label, agent lock eligible.       |
| Proper explicit subset                                                         | `scope=selected`, coverage false; unselected Members neither queried nor included in ready/lock. |
| Empty tool array, self, duplicate, unknown, Role fallback, >32, >256-byte name | Preflight error; zero endpoint IO/capacity leak.                                                 |
| Slash `Dave, Kelly` or `Mary Jane,Kelly`                                       | Trim segment edges, preserve internal spaces, resolve exact names, normalize manifest order.     |
| Slash leading/trailing/doubled comma or >4,096 bytes                           | Parser error; zero endpoint IO.                                                                  |
| Comma-bearing configured name                                                  | Slash explicit selection unsupported; omission/tool-array selection remains available.           |
| Only caller configured, omission                                               | `ready/no-other-members`, `scope=all`; zero endpoint IO.                                         |
| Only caller configured, explicit selection                                     | Empty invalid or self/unknown error; never selected-empty ready.                                 |
| All frozen targets idle in initial round                                       | Scoped `ready/initial-round`.                                                                    |
| Busy targets settle; full frozen-scope next round idle                         | Scoped `ready/after-wait`.                                                                       |
| Earlier-idle target becomes busy before final round                            | Wait another event-driven full frozen-scope round.                                               |
| Target compacts                                                                | Non-ready; wait for mechanical settle.                                                           |
| Target idle with pending messages                                              | May satisfy momentary Activity; retain signal and make no empty-queue claim.                     |
| Target offline/disconnects/restarts                                            | `offline`; cancel peers; never treat idle/reconnect.                                             |
| Agent all-scope/full-explicit and every target owns blocking wait              | `wait-lock`; release caller only.                                                                |
| Agent proper subset and every selected target owns blocking wait               | Not Crew Idle Lock; continue bounded wait without exposing targets.                              |
| Slash full selection and every target owns blocking wait                       | No `wait-lock` because slash owns no agent marker; continue bounded observation.                 |
| Every Member agent starts a full Crew Idle Gate                                | Each proven caller may release only itself; no chosen leader/remote cancellation.                |
| Agent accepts inbound message while waiting                                    | `message-received`; cancel tool and consume exact message next.                                  |
| Slash receives inbound message/local agent starts                              | `local-activity`; cancel command only and leave message/activity untouched.                      |
| Slash invoked while local busy/compacting/queued                               | `local-busy`; do not call `waitForIdle` or touch endpoints.                                      |
| Slash reload/session replacement/shutdown                                      | Cancel/cleanup; no stale UI/model entry.                                                         |
| Deadline meets offline event                                                   | Offline wins only if validated before/equal arbitration; committed timeout remains.              |
| Round 32 ready                                                                 | `ready`; round cap does not discard success.                                                     |
| Round 32 non-ready needing another                                             | `unstable`.                                                                                      |
| Caller Membership changes                                                      | Abort/error; frozen roster never substitutes.                                                    |
| Manifest changes during operation                                              | Frozen roster/targets/coverage unchanged; next invocation sees edit.                             |
| Late/duplicate callback after terminal                                         | Cleanup no-op; cannot change result.                                                             |

## Boundaries

Crew Idle Gate is not:

- a Response or task-completion wait;
- availability, readiness, productivity, health, or quality inference;
- a quiet-window or atomic-simultaneity guarantee;
- a scheduler, task router, retry/escalation policy, or recovery action;
- a persistent/background monitor or wait history;
- a Role/glob/pattern selector or general dependency-cycle detector;
- authority granted to Lead, Role, Origin, human command, or any message;
- standalone `pi-bebop` CLI parity, a mathematical atomic snapshot, or automatic Lead action.

V1 delivers the membership-scoped agent tool and human `/crew member-idle` command through one shared application operation. Surface scheduling intentionally remains non-identical.
