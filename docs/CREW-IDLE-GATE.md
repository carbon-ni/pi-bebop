# Crew Idle Gate

## Problem

A coordinating Member can wait for one other Member today, but a Lead loop often
needs to pause until every other configured Member has settled before deciding
what to route next. Repeated Member Status calls spend model turns, remember
stale observations, and can act after different Members were idle at different
times. Blocking idle waits can also lock the Crew when every Member is waiting
for another Member to settle.

Bebop needs one bounded, event-driven whole-Crew coordination primitive. It must
be honest about distributed observations, release its caller from a whole-Crew
wait lock, and never mutate another Member's run.

## Product surface

A later implementation exposes this joined-Member tool:

```text
wait_for_crew_idle({ timeout_seconds?: 1800 })
```

**Crew Idle Gate** is one transient blocking operation. The caller's current Pi
run remains busy while the tool is pending, so an automatic caller loop cannot
start its next iteration. No repeated model call is made while Bebop observes
mechanical state.

Any Current member may use the gate. Lead is a workflow convention, never a
permission. The caller decides what to do with the result; the gate never routes
work itself.

## Frozen target set and deadline

At gate start Bebop must synchronously acquire the caller's single blocking-wait
slot, then freeze:

- the caller's current Membership identity;
- every other Member from the current Crew manifest, in manifest order;
- one absolute deadline from a monotonic clock.

The caller is excluded because its pending gate makes its own Activity busy. A
one-Member Crew returns `ready/no-other-members` without endpoint IO.

A manifest edit, newly joined Member, Role change, or replacement Membership
after start does not mutate the frozen target set. Loss or replacement of the
caller's Membership aborts the gate. A frozen target that restarts, disappears,
or answers with another identity produces `offline` or an explicit protocol
error; Bebop never silently substitutes a different Member or resubscribes.

Timeout is one operation-wide bound: default 1,800 seconds, accepted range
60–7,200 whole seconds. Target probes, subscriptions, status rounds, and cleanup
all consume the same deadline. Deadlines are never multiplied by Member count or
round count.

## Final status round

A **Final Crew Status Round** is one bounded concurrent query of the frozen target
set. Each response contains configured name/Role, Presence, Activity,
pending-message signal, and its own observation timestamp. Responses are
validated against the exact target and normalized back to manifest order; arrival
order has no product meaning.

The gate returns `ready` only when every target in one completed round reports
`online/idle`:

- `no-other-members` — the target set was empty;
- `initial-round` — the first round observed every target idle;
- `after-wait` — one or more event-driven waits preceded the final round.

A Final Crew Status Round is not an atomic distributed snapshot. Its Member
observations occur at different instants, and `ready` means only
**all-observed-idle in that round**. It does not promise simultaneous or future
idleness, an empty pending-message queue, availability, willingness, health,
acknowledgement, Response, task completion, progress, or quality.

Prior idle observations never satisfy a later round. If Dave was observed idle,
then Kelly settles, but the next full round observes Dave busy, the gate waits
again instead of returning from remembered state.

## Event-driven rounds

The gate follows this loop without model polling:

1. Run one concurrent Crew Status round.
2. Return `ready` if all frozen targets are `online/idle`.
3. Return `offline` if any frozen target is unreachable.
4. Return `wait-lock` if the exact Crew Idle Lock predicate below is true.
5. Atomically subscribe to idle and blocking-wait transitions for every target
   observed busy or compacting. Subscribe-and-snapshot must not lose a transition
   between the status response and subscription.
6. After every selected non-idle target produces a terminal idle observation,
   run a new full status round.

A target that is already idle at subscription time completes that subscription
without a lingering listener. Any offline, message, deadline, abort, Membership,
protocol, or capacity terminal cancels all remaining probes and subscriptions.
Late callbacks perform cleanup only and cannot replace the committed result.

There is no polling interval, sleep, background watcher, automatic retry, or
model-driven status loop. The operation permits at most **32 completed status
rounds**, including the initial round. A ready 32nd round succeeds; a non-ready
32nd round that would require another round returns `unstable`. This finite cap
bounds rapid state churn independently of the wall-clock deadline.

## Crew Idle Lock

A **Crew Idle Lock** is proven only when one coherent observation establishes:

1. the caller owns the active `crew-idle` blocking-wait slot;
2. the frozen target set is non-empty and contains no offline or unknown target;
3. every frozen target currently owns an explicit blocking-wait marker of
   `member-idle` or `crew-idle`.

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

This predicate intentionally detects the whole-Crew case Cristian requested. It
is not a general wait-for graph. For example, if Dave waits for the caller while
Kelly is idle, not every target is waiting, so the gate does not claim
`wait-lock`; bounded timeout/message/offline/abort remain safeguards. Wait target
identity stays private rather than being exposed for partial-cycle diagnosis.

## Closed terminal outcomes

| Outcome | Meaning | Caller continuation |
| --- | --- | --- |
| `ready` | One final round observed every frozen target `online/idle`. | Ordinary continuation; caller chooses next action. |
| `wait-lock` | Exact whole-Crew blocking-wait predicate was observed. | Ordinary continuation; caller chooses recovery. |
| `offline` | One or more frozen targets were unreachable before/during gate. Offline is not idle. | Ordinary continuation with manifest-ordered blockers; no reconnect. |
| `timeout` | Absolute operation deadline expired before another result committed. | Ordinary continuation with bounded last observations. |
| `unstable` | Non-ready round 32 would require another round. | Ordinary continuation with bounded last observations. |
| `message-received` | A Bebop message was accepted for the caller while gate was pending. | Terminating tool result; unchanged message is the next model context under its original delivery mode. |
| error | Caller abort, Membership change, malformed/foreign response, capacity, or transport failure. | Error continuation after complete cleanup. |

Outcomes contain only the frozen configured identities, mechanical observations,
outcome/disposition, per-Member timestamps, and round-completion timestamp. They
contain no messages or conversation data.

## Race ownership

One caller-local arbiter owns the terminal. Accepted inbound message has priority
at the same scheduling boundary so context is never skipped. Otherwise the first
validated terminal claim wins. For simultaneous mechanical candidates the
priority is:

```text
message-received > wait-lock > ready > offline > unstable > timeout
```

This order resolves only candidates already observed at the same boundary; it
does not reinterpret a later event as earlier. Explicit caller abort or
Membership loss cancels immediately unless an inbound message was already
accepted and must be drained. After a terminal commit, every later timer, socket,
status, marker, or subscription callback is an idempotent cleanup no-op.

Only one local blocking Member Idle Wait or Crew Idle Gate may own the slot. A
second local wait rejects before endpoint IO and cannot share, replace, or clear
the first operation. The tool must be called alone/sequentially because
`message-received` relies on terminating the content-free continuation.

## Decision table

| Scenario | Required result |
| --- | --- |
| Only caller is configured | `ready/no-other-members`; zero endpoint IO. |
| All targets idle in initial round | `ready/initial-round`. |
| Busy targets settle; full next round all idle | `ready/after-wait`. |
| Earlier-idle target becomes busy before final round | Wait another event-driven round. |
| Target compacts | Non-ready; wait for mechanical settle. |
| Target reports idle with pending messages | May satisfy the momentary Activity predicate; result retains pending signal and makes no empty-queue claim. |
| Target offline initially or disconnects/restarts | `offline`; cancel peers; never treat as idle or reconnect. |
| All targets explicitly own blocking idle waits | `wait-lock`; release caller only. |
| Some targets wait while another is idle/working/compacting | Not a proven Crew Idle Lock. |
| Every Member starts a Crew Idle Gate | Each proven caller may release only itself; no chosen leader and no remote cancellation. |
| Accepted inbound message while waiting | `message-received`; cancel gate and consume exact message next. |
| Deadline meets offline event | Offline wins only if validated before/equal terminal arbitration; otherwise already-committed timeout remains. |
| Round 32 is ready | `ready`; round cap does not discard success. |
| Round 32 is non-ready and needs another round | `unstable`. |
| Caller leaves, switches Membership, reloads, shuts down, or aborts | Explicit cancellation/error; no automatic restore. |
| Manifest changes during gate | Frozen target set remains; next invocation sees new manifest. |
| Late or duplicate callback after terminal | Cleanup no-op; cannot change result. |

## Boundaries

Crew Idle Gate is not:

- a Response or task-completion wait;
- availability, readiness, productivity, health, or quality inference;
- a quiet-window or atomic-simultaneity guarantee;
- a scheduler, task router, retry/escalation policy, or recovery action;
- a persistent/background monitor or wait history;
- an arbitrary Member subset or general dependency-cycle detector;
- authority granted to Lead, Role, Origin, or any message.

The first delivery is the agent-facing extension tool. CLI and slash-command
parity are separate product decisions.
