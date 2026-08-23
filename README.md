# Pi Bebop

<img  width="250" alt="screenshot-2026-08-22_15-39-54" src="https://github.com/user-attachments/assets/9430855c-9060-4f1f-b7a8-e8d3b03ce232"  align="left"  />

Give a small dysfunctional but effective crew to your Pi agents.

</br>
</br>
</br>
</br>
</br>

## Getting started

Create the crew manifest in a trusted project. `.pi/bebop` is the canonical layout; `.pi/crew` is supported as an exact compatibility layout for existing projects:

### Setup

```bash
mkdir -p .pi/bebop/sockets
cat > .pi/bebop/crew.json <<'JSON'
{"version":1,"members":[
  {"name":"lead","role":"lead","socket":"sockets/lead.sock"},
  {"name":"developer","role":"developer","socket":"sockets/developer.sock"}
]}
JSON
```

The project must be trusted by Pi before this manifest can be read. Trust is a
project security boundary, not a property granted by the filename or socket
path.

## The crew

> This is why it is a dysfunctional crew: members may or may not be there, by
> design. You can create a script to start the crew yourself.

A socket under `.pi/bebop/sockets/` selects only `.pi/bebop/crew.json`; a socket under `.pi/crew/sockets/` selects only `.pi/crew/crew.json`. There is no fallback or merge when both manifests exist. Other `.pi/<name>/crew.json` paths are rejected as untrusted, and missing, malformed, or member-mismatched manifests report their actionable cause.

### Join the crew

Start each member with its crew identity:

```bash
pi --crew-socket "$PWD/.pi/bebop/sockets/lead.sock"
pi --crew-socket "$PWD/.pi/bebop/sockets/developer.sock"
```

`--crew-socket` starts Bebop's socket server and selects the member represented
by that endpoint. Use `pi --crew` to start a server without joining a crew.

For an existing session, join a crew endpoint with:

```text
/crew join .pi/bebop/sockets/lead.sock
```

### Crew members

Use `/crew members` to inspect the authoritative roster for the active membership.

```text
Crew: /project/.pi/bebop/crew.json
Members (3):
- lead (lead) — current — /project/.pi/bebop/sockets/lead.sock
- Bob (dev) — online — /project/.pi/bebop/sockets/Bob.sock
- Kelly (qa) — offline — /project/.pi/bebop/sockets/Kelly.sock
```

Rows show configured project socket paths and exactly `current`, `online`, or
`offline`; global UUID destinations, aliases, and full instructions are never
shown. The current member is identified from membership without probing it;
other endpoints are probed independently. If not joined, `/crew members` prints
`Crew not joined. Use /crew join <socket>.` and performs no discovery. List
output is displayed without starting an agent turn. Use `/crew status`,
`/crew leave`, or `/crew stop` to inspect or release the current identity.

### Member role instructions

A member may use either inline instructions or a Markdown file, but never both:

```json
{ "name": "Bob", "role": "dev", "socket": "sockets/Bob.sock", "instructionsFile": "instructions/dev.md" }
```

File paths are relative to the manifest and must remain under that layout's
`.pi/bebop/instructions/` (or compatibility `.pi/crew/instructions/`) directory;
symlink escapes, directories, invalid UTF-8, NULs, blank files, and files over
64 KiB are rejected before membership is claimed. The file is read once during
startup, restore, or explicit join/rejoin. Changes are not hot-reloaded into an
active session; leave and rejoin to refresh. Members without either field behave
as before.

### Members presence

Presence activity is enabled by default for joined manifests and appears as
chat-only `[crew]` activity (`triggerTurn: false`); disable it with
`"presence": { "notifications": false }`. Online means reachable at the last
observation, not idle or available.

### External project members

Members can join from any path, useful for worktrees, or external contributions.

Both startup and runtime commands use the manifest adjacent to the absolute endpoint
and never consult the current working tree's manifest:

```bash
pi --crew-socket /worktree-B/.pi/bebop/sockets/dev1.sock
# in an existing session:
/crew join /worktree-B/.pi/crew/sockets/dev1.sock
```

### Direct socket messaging from a shell

The package also installs `pi-bebop`, which targets one endpoint directly. It does
not read the crew manifest or resolve names and roles:

```bash
pi-bebop send --socket .pi/bebop/sockets/lead.sock \
  --message "Review the current changes"
printf 'line one\nline two\n' | pi-bebop send --socket .pi/crew/sockets/lead.sock --stdin --wait accepted --format json
```

### Role-based messaging

Once joined, use `send_follow_up` by default:

```text
send_follow_up({
  "member": "developer",
  "message": "Please confirm the endpoint is working."
})
```

Use `redirect_member` only when the message should change active work. Both
return an accepted delivery acknowledgement with `deliveryId` and disposition
(`direct`, `queued`, or `steered`). `wait_for: response` is explicitly
unsupported because Pi lifecycle events cannot prove delivery-level response
correlation; it never consumes an unrelated global `turn_end`. Members can be addressed by unique name or role. A live endpoint owned by another session is
never overwritten; stale endpoints may be reclaimed.

### Hard interrupt

Escalate deliberately: use `send_follow_up` for normal delivery, `redirect_member`
when the target should change direction after current work, and `interrupt_member`
only to stop and recover work that is stuck, harmful, or based on invalid
assumptions. Interrupt is live-only: the target records pending recovery guidance
before requesting a best-effort abort, then hands the guidance to Pi ahead of
older follow-ups; recovery survives reload until handed off. It cannot roll back
filesystem, shell, network, or already-completed side effects—verify state before
continuing.

### Durable member inbox

Members may be offline, but work can still be left durably. `send_to_inbox`
persists one structured message into the target member's project-local inbox;
the recipient reads it later as a normal follow-up, even after a restart:

```text
send_to_inbox({
  "member": "developer",
  "message": "Review the proposed API change when you are next available."
})
```

Success returns a stable item id and means **persisted** — never delivered,
started, completed, or answered. `send_to_inbox` works whether the peer is
online or offline and never requires the peer's endpoint or a live turn.

A joined member's inbox is handed to Pi automatically: the oldest pending item
is offered as a normal follow-up on membership start/restore, on a best-effort
hint, and when a turn ends. Handoff is FIFO and never steers active work;
follow-ups already accepted by Pi stay ahead. An item is removed only after
durable session evidence contains its stable id, so a crash between handoff and
removal is reconciled on restart.

Inspect and control the local inbox with `/crew inbox`:

```text
/crew inbox status          # bounded pending metadata
/crew inbox cancel <id>     # remove one pending item (idempotent)
/crew inbox pause           # stop automatic offering (items are kept)
/crew inbox resume          # resume automatic offering
```

`status` shows pending count, offering state, and stable ids/metadata — never
message contents. `pause` stops automatic offering without deleting pending
items; `resume` restores it. `cancel` removes only a pending item and is
idempotent.

**Bebop is a transport, not a workflow.** The inbox stores and hands over
messages; it does not track whether a software task was completed, and it has
no Git, review, CI, or worktree integration. It never claims exactly-once
execution. For live communication use `send_follow_up`; to change what a
member is doing right now use `redirect_member`.

### External crew intake (defined)

External sessions, scripts, and local automation can address a member socket,
but leaving a durable message _for the crew_ requires one configured contact.
The manifest may select it by exact member name:

```json
{"version":1,"members":[...],"intake":{"contact":"Mary"}}
```

Without `intake`, external crew intake is disabled — Bebop never falls back to
a lead, product owner, or first-online member. Messages are one-way and
unverified (the external label is claimed, never authenticated); they are
persisted to the contact's inbox and may arrive while the contact is offline.
The product owner is the recommended contact for software crews, but any
configured member can be selected. The contact triages intake (ignore,
clarify, or forward internally); Bebop does not classify content, pick a
worker, or track intake as accepted work. The command-line intake surface is
not yet available.

#### One-way intake from the CLI

`pi-bebop send` accepts exactly one target: `--socket` for direct live
delivery, or `--crew <manifest>` for durable one-way intake through the
configured contact:

```bash
pi-bebop send --crew .pi/bebop/crew.json \
  --message "Please evaluate this product request" \
  --from "jira-automation"
```

Output is a persisted acknowledgement with the stable item id and the
contact's name/role — never delivered, completed, assigned, or answered. The
contact may be offline; no endpoint probe or running Pi session is required.
`--from` is stored as a claimed, unverified external label; a crew origin can
never be claimed through the CLI.

The explicit `--crew` path is caller consent: the CLI enforces the exact
supported layout (`.pi/bebop` or `.pi/crew`) and filesystem permissions, but
it never reports the project as Pi-trusted. With no configured contact the CLI
reports `external-intake-disabled`; unsafe layout, full inbox, malformed
messages, and persistence failures each have distinct stable errors and
nonzero exit codes.

External intake is one-way and has no auth, callbacks, broadcasts, or
task/Git integration: the external actor cannot read responses, and Bebop does
not route, classify, or dispatch the message to a worker.

#### Durable crew broadcast

`broadcast_to_crew` fans one non-interrupting message out to every other
configured member, in manifest order, regardless of presence. It is available
only to a joined crew member; each recipient later receives its own copy
through the normal Inbox-to-follow-up handoff and never has active work
interrupted or redirected. The sender is excluded.

```bash
broadcast_to_crew({
  message: "API contract changed; pull latest plan before continuing",
  instructions: ["Acknowledge constraint in your next normal report"]
})
```

A stable broadcast id plus deterministic per-recipient item ids make retrying
safe and idempotent: recipients already persisted are reported as
already-persisted, and a retry never duplicates a successful copy. The tool
reports a persisted count and per-recipient disposition; a recipient with a
full inbox is reported as failed for that recipient without corrupting the
successful recipients. Use it for shared team-wide information, not for work
that should have a single owner — use `send_follow_up` or `send_to_inbox` for
a specific member instead.

## Development

```bash
npm install
npm run build
```

The package is published to npm as `pi-bebop` and `pi-bebop-cli`.

### Testing

```bash
npm test
```

The quick test suite only packs/extracts locally and runs the bundled CLI; it does not perform registry IO.

### Release

```bash
make package-verify
# equivalent: npm run verify:package
```

Release verification is intentionally separate from quick tests because it installs a pinned consumer dependency set and may require network or a warm npm cache.
