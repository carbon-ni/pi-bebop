# Pi Bebop

<img width="240" height="164" alt="bebop" src="https://github.com/user-attachments/assets/ff4eccd9-73e7-4e09-a617-ce7b7db7e299" align="right" />

Give a small dysfunctional but effective crew to your Pi agents.

</br>
</br>
</br>
</br>
</br>

## What is Pi Bebop

Pi Bebop gives your Pi agents a project-local crew: independent members with
names and roles, a trusted manifest, and explicit communication and lifecycle
tools between them. Members join from any worktree or path, and every agent-facing
surface is active only while the member is joined.

Bebop is transport, not workflow. It moves messages and lifecycle signals between
members; it has no task, Git, review, or CI ownership.

## Why Bebop

- **Independent Pi Members** — each member is its own Pi session with its own
  context, plans, and tools; nothing is shared implicitly.
- **Project-local crew identity** — a trusted `.pi/bebop/crew.json` manifest owns
  names, roles, sockets, and instructions; no global registry.
- **Explicit communication and lifecycle tools** — every message, request, inbox,
  interrupt, and wait has a distinct tool with a one-phrase guarantee.

## Install

### Extension

```bash
## Npm
pi install npm:@carbon-ni/pi-bebop

## GitHub release
pi install git:github.com/carbon-ni/pi-bebop
```

### CLI

```bash
## Install
npm install -g @carbon-ni/pi-bebop

## Npx
npx @carbon-ni/pi-bebop --help
```

Install from this checkout so the `pi-bebop` bin is on your PATH:

```bash
npm link
pi-bebop --help
```

Or install the packed tarball into a project:

```bash
npm install ./carbon-ni-pi-bebop-0.1.0.tgz
npx pi-bebop --help
```

`pi-bebop --help` prints deterministic root help and exits 0 with no project,
session, or filesystem IO. Leaf help is `pi-bebop <command> --help`; leaf `-h`
is intentionally a structured usage error (exit 2), matching the
canonical-long-flags-only contract. The scoped package is prepared for publication
but is not published to npm yet; install from a checkout or tarball locally.

## Start a Crew

```bash
pi-bebop crew init
# discover the configured roles before choosing identity (read-only):
pi-bebop crew roles
pi --crew-role lead
pi --crew-role developer
# in each member session, inspect the authoritative roster:
/crew members
```

`crew init` creates `.pi/bebop/crew.json`, shared `common.md`, role instruction
templates, and a `sockets/` directory — deterministic, non-interactive, and a
safe no-op on rerun. Review names, Intake contact, common guidance, and role
instructions before joining. `AGENTS.md` remains project-wide agent guidance;
`common.md` is shared crew collaboration guidance; role files define
member-specific responsibilities.
`pi-bebop crew roles` prints the exact configured role values (TOON by default,
`--format json|text`) rooted at the current working directory, so startup role
selection never depends on opening `crew.json` manually; it never starts a
server, joins, or mutates files. Start each member by its manifest role;
`/crew members` shows exactly `current`, `online`, or `offline` with configured
project socket paths.

## Choose communication

| Tool                  | Use when                                                | Guarantee                                                                                                               |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `send_member_request` | you need one correlated answer, report, or verdict      | exactly one Response, offline, timeout-after-idle, or timeout-max-wait — you resume via a later `crew-wait-resume` turn |
| `send_follow_up`      | ordinary information                                    | accepted delivery only; no correlated Response expected                                                                 |
| `redirect_member`     | change what a member is doing next                      | steered before the target's next model step; never aborts                                                               |
| `send_to_inbox`       | the peer may be offline                                 | persisted durably; read later as a normal follow-up                                                                     |
| `interrupt_member`    | work is stuck, harmful, or based on invalid assumptions | best-effort abort plus recovery guidance; never rolls back side effects                                                 |
| `broadcast_to_crew`   | a shared team-wide constraint                           | durable per-recipient copy for every other member; idempotent retry                                                     |

`wait_for_member_idle` blocks the current run until the target settles to mechanical idle, goes offline, the bounded timeout expires, or an accepted
Bebop message releases the wait under its original delivery mode. For the supported solitary invocation, a waking message is consumed immediately
in the next model continuation; `message-received` never implies idle or completion. Call this coordination wait alone, not in a parallel tool
batch, because its terminating result must be the only result in the batch. Under Pi 0.84.x a mixed batch may run one tool-result continuation
before consuming the unchanged waking message once on the following turn. The bounded timeout is always the fallback.
`wait_for_request_outcome` yields the run and resumes in a later turn, so
correlated Request outcome waits never deadlock.

## Boundaries

- Roles are responsibility, not permissions; repeated roles route by exact name.
- Online or idle is reachability at last observation — never availability or
  progress.
- Accepted, Persisted, or Response is never completion; Bebop has no task, Git,
  review, or CI ownership.
- Bebop is transport, not workflow: it never claims exactly-once execution and
  never picks workers or classifies content.

## Development

```bash
npm install
make hooks-install
make hooks-check
npm run build
npm test
```

`make hooks-install` opts this checkout into the repository-owned pre-push hook;
`make hooks-check` verifies the local Git setting and executable hook without
changing anything. Hooks provide early feedback, but GitHub CI remains
authoritative. `make all` runs the same pre-push/CI gate (format, package, lint,
build, test, security).

Release verification is separate because it installs a pinned consumer dependency
set and may need network:

```bash
make package-verify
```
