# Pi Bebop

<img width="240" height="164" alt="bebop" src="https://github.com/user-attachments/assets/ff4eccd9-73e7-4e09-a617-ce7b7db7e299" align="right" />

Pi Bebop gives Pi agents a project-local crew.

It manages crew identity, member lifecycle, and explicit communication. It does
not manage tasks, Git, reviews, tests, CI, or releases.

This document follows the [Pi Bebop documentation style](docs/STYLE.md).

## What Bebop provides

- A trusted crew manifest in `.pi/bebop/crew.json`.
- Independent Pi sessions with exact member names and roles.
- Explicit tools for live, durable, and correlated communication.
- A shared Crew Board for pull-based project context.
- A standalone CLI for crew setup and member operations.

A role describes responsibility. A role does not grant permission. Presence only
shows endpoint reachability. It does not show availability or progress.

## Install

### Install as a Pi extension

```bash
pi install npm:@carbon-ni/pi-bebop
```

Install from a GitHub release when you need a release build:

```bash
pi install git:github.com/carbon-ni/pi-bebop
```

### Install the CLI

```bash
npm install -g @carbon-ni/pi-bebop
pi-bebop --help
```

For this checkout, link the package:

```bash
npm link
pi-bebop --help
```

`pi-bebop --help` performs no project, session, or filesystem work. Use
`pi-bebop <command> --help` for a command. Use long flags in scripts.

## Start a crew

Create the standard crew files:

```bash
pi-bebop crew init
```

List roles before you start members:

```bash
pi-bebop crew roles
```

Start one Pi session for each manifest role:

```bash
pi --crew-role lead
pi --crew-role developer
```

In a joined session, inspect the roster:

```text
/crew members
```

`crew init` creates the manifest, shared instructions, role instructions, and
the socket directory. It does not start members or create a Git commit. Review
the generated names, contact, and instructions before you join.

Read [Crew init](docs/CREW-INIT.md) for the full layout and conflict rules.

## Choose a communication tool

| Tool | Use | Result |
| --- | --- | --- |
| `send_follow_up` | Send normal information. | The target accepts a live non-interrupting message. |
| `redirect_member` | Change the target's next model step. | The target receives a live steer. It does not abort work. |
| `send_to_inbox` | Keep a message for an offline member. | Bebop persists one Inbox item. |
| `send_member_request` | Require one correlated answer. | Bebop returns a request ID after acceptance. |
| `respond_to_member_request` | Answer an active member request. | Bebop sends one correlated response. |
| `wait_for_request_outcome` | Yield after you sent a member request. | Bebop resumes with the oldest Response/offline/timeout or one 180-second still-pending reminder; settled requests return `all-settled`. |
| `interrupt_member` | Stop harmful or invalid active work. | Bebop requests an abort and sends recovery guidance. |
| `broadcast_to_crew` | Share one constraint with other members. | Bebop persists one Inbox item for each recipient. |
| `send_to_crew` | Send a durable letter to another local crew. | Bebop persists it for that crew contact. |
| `get_member_status` | Check one member's mechanical state. | Bebop returns a bounded status snapshot. |
| `wait_for_member_idle` | Wait for one member to settle. | Bebop returns an idle, offline, timeout, or message result. |
| `read_crew_board` | Read shared pull-based context. | Bebop returns a bounded page of Crew Posts. |
| `leave_crew_post` | Keep a reusable note for the crew. | Bebop persists an attributed Crew Post. |

Accepted means that a live endpoint acknowledged delivery. Persisted means that
Bebop stored data. Neither result means that work is complete or approved.

Read [UL.md](UL.md) before you use terms in crew instructions or messages.

## Work with another crew

Use `send_to_crew` with an absolute manifest path. Both crews must use the same
machine. The source member must be joined.

```text
send_to_crew({
  manifestPath: "/projects/beta/.pi/bebop/crew.json",
  message: "Can you review this change?"
})
```

The message is a one-way durable letter. It is not a live route, a response,
or proof that the receiver read it.

## Learn more

- [Ubiquitous language](UL.md) — canonical product terms.
- [Architecture](docs/ARCHITECTURE.md) — layers, trust, lifecycle, and storage.
- [Software crew workflow](docs/SOFTWARE-CREW-WORKFLOW.md) — optional role conventions.
- [Member request workflow](docs/MEMBER-REQUEST-WORKFLOW.md) — bounded correlated requests.
- [Crew Board](docs/CREW-BOARD.md) — shared pull-based context.
- [Crew idle gate](docs/CREW-IDLE-GATE.md) — bounded crew-idle observation.
- [Crew agreements](docs/CREW-AGREEMENTS.md) — future retrospective contract.
- [Crew message log](docs/CREW-MESSAGE-LOG.md) — retained messaging evidence contract.
- [Actionable errors](docs/ACTIONABLE-ERRORS.md) — user-facing failure contract.
- [Documentation style](docs/STYLE.md) — STE100 profile.

## Develop

```bash
npm install
make hooks-install
make hooks-check
npm run build
npm test
```

`make hooks-install` enables repository hooks. `make hooks-check` checks that
installation. Hooks, the watcher, and GitHub CI run lint and tests. `make all`
prints `true` on success. On failure it prints `false` and the failing command
output. GitHub CI remains authoritative.

Run package verification separately. It installs a consumer dependency set and
can need network access.

```bash
make package-verify
```
