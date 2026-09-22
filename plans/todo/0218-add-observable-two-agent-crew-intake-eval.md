---
id: TASK-0218
title: Add observable two-agent Crew Intake eval
status: todo
depends_on: [TASK-0216]
priority: high
tags: [crew, intake, eval, smoke, tmux, lifecycle, observability, tdd]
---

# Add observable two-agent Crew Intake eval

## Problem

Crew Intake has deterministic automated tests, but a developer cannot quickly launch two visible Pi members, publish a filesystem Intake file, and observe the real delivery path. We need an isolated external harness that makes lifecycle and evidence visible without turning Bebop into an orchestrator or silently spending model calls.

## Desired outcome

One bounded command prepares a disposable two-Member Crew and opens a named tmux session with both interactive Pi agents plus a control pane. The user can publish a `.md`/`.txt` file with a separate explicit command, watch the configured contact receive one unverified external-intake Follow-up, inspect captured evidence, and clean up every process and temporary artifact.

## Eval cases

### Case A — online configured contact

- Start `Contact` and `Peer` from the same disposable trusted Crew project.
- Publish one fixed UTF-8 Markdown fixture with `.draft` → atomic `.md` rename.
- Expect the file to leave `new/`, appear once in `processed/`, reach `Contact` exactly once as `external intake`, and never reach `Peer`.

### Case B — contact joins later

- Start only `Peer`, publish the same bounded fixture, then start `Contact` explicitly.
- Expect a durable Inbox item for the exact configured contact, no delivery to `Peer`, and one Follow-up to `Contact` after it joins.

These are transport smoke cases, not semantic quality comparisons. There is no fabricated baseline or claim that model output proves correctness.

## Acceptance criteria

- [ ] Add an external harness under `skills/crew-creator/scripts/`; production Bebop does not start agents, own eval state, or grade results.
- [ ] `start` preflights `pi`, `tmux >= 3.5`, the built Bebop extension/CLI, provider/model arguments, project trust mode, unique session name, bounds, and paths before creating any process.
- [ ] Every run uses a fresh disposable project, session directory, two-Member manifest, instructions, sockets, Intake directories, logs, and tmux session; it never joins or mutates the developer's active Crew.
- [ ] tmux shows separate panes/windows for `Contact`, `Peer`, and a control/evidence surface. Each agent starts with exact `--crew-role`, explicit model/provider/thinking configuration, isolated session storage, and the project approved only for that run.
- [ ] Starting the harness performs no model call. `publish` is a separate explicit action that shows the exact file and warns that delivery may trigger a paid model turn.
- [ ] `publish` writes a temporary `.draft`, fsyncs/closes it, then atomically renames to a bounded direct-child `.md`/`.txt` filename; arbitrary path/content injection is rejected.
- [ ] Support both predeclared cases: online contact and contact-joins-later. Lifecycle transitions wait on observable socket/file/session evidence with finite deadlines, never arbitrary sleeps or idle-state completion inference.
- [ ] `status` reports process/pane liveness, socket claims, Intake file state, and bounded capture paths without claiming the message was read, acted on, or completed.
- [ ] `capture` records bounded tmux pane text, process exit state, manifest/config snapshot, Intake directory listing, and timestamps beneath the run directory; it redacts credentials and does not treat transcript text as authoritative completion.
- [ ] `stop` is idempotent and terminates the exact tmux session and child processes, then retains or removes the run directory only as explicitly requested. SIGINT, startup failure, timeout, and partial launch use the same cleanup path.
- [ ] Deterministic tests use fake `pi`/tmux/process adapters for preflight, command construction, isolation, atomic publication, timeout, cleanup, and evidence. One opt-in local smoke verifies the real tmux layout without making a model call.
- [ ] Documentation gives copy-paste `start`, `publish`, `attach`, `status`, `capture`, and `stop` examples plus expected visible observations and troubleshooting.
- [ ] A live paid run requires explicit user agreement on provider/model/thinking, cases, repetitions, concurrency, timeouts, and whether artifacts may be retained.

## Non-goals

CI-running paid agents, semantic grading, claiming model independence, remote Intake, production process supervision, replacing deterministic Intake integration tests, or interpreting agent text as proof of task completion.
