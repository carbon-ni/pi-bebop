# Pi Bebop

Give a small disfunctional crew to your PI agents.

## Crew Getting Started

This is the shortest path from a trusted project to the first role-based message.

### 1. Create the project-local crew manifest

Run these commands from the project root. The socket directory may start empty; running Pi sessions publish the endpoint symlinks.

```bash
mkdir -p .pi/crew/sockets
cat > .pi/crew/crew.json <<'JSON'
{
  "version": 1,
  "members": [
    { "name": "lead", "role": "lead", "socket": "sockets/lead.sock" },
    { "name": "developer", "role": "developer", "socket": "sockets/developer.sock" },
    { "name": "qa", "role": "QA", "socket": "sockets/qa.sock" }
  ]
}
JSON
python3 -m json.tool .pi/crew/crew.json >/dev/null
```

The project must be trusted by Pi before this manifest can be read. Trust is a project security boundary, not a property granted by the filename or socket path.

### 2. Start one Pi session for each role

In three terminals, from the same trusted project, start the sessions with their configured endpoint:

```bash
pi --crew-socket "$PWD/.pi/intray/sockets/lead.sock"
pi --crew-socket "$PWD/.pi/intray/sockets/developer.sock"
pi --crew-socket "$PWD/.pi/intray/sockets/qa.sock"
```

`--crew-socket` starts the base intray server and adopts the member represented by that manifest path. The selected member becomes the current identity; the internal global UUID socket is only transport plumbing and should not be copied into the manifest.

For an already-running session, use its command prompt instead:

```text
/crew join .pi/intray/sockets/lead.sock
```

### 3. Check membership, then send the first message

In any joined session, these commands report the current state and live sessions:

```text
/crew status
/crew list
```

From the lead agent, use the role-aware tool with a synchronous response (the default):

```text
send_to_member({
  "member": "developer",
  "message": "Please confirm the crew endpoint is working.",
  "wait_until": "turn_end",
  "reply_behavior": "end_conversation"
})
```

The `developer` session receives the message and the tool returns after its turn. Address QA the same way by changing `member` to `qa`.

For callback-style delivery, return as soon as the message is queued and opt in to sender metadata:

```text
send_to_member({
  "member": "qa",
  "message": "Please run the smoke check and report back.",
  "wait_until": "message_processed",
  "reply_behavior": "allow_reply"
})
```

A callback message carries one machine-readable `<sender_info>` block (sender session id and optional name), not a repeated instruction block. The recipient can reply with `send_to_session` using that sender identity, for example:

```text
send_to_session({
  "sessionId": "<session-id-from-sender_info>",
  "action": "send",
  "message": "Smoke check passed.",
  "wait_until": "message_processed",
  "reply_behavior": "end_conversation"
})
```

To target a configured endpoint directly instead of resolving a role, use its repository-local path:

```text
send_to_session({
  "socketPath": ".pi/crew/sockets/qa.sock",
  "action": "send",
  "message": "Please verify the release notes.",
  "wait_until": "off",
  "reply_behavior": "end_conversation"
})
```

### Lifecycle and troubleshooting reference

- `/crew status` shows `stopped`, `online`, or `joined`; joined state includes crew, member, and endpoint.
- `/crew list` observes live sessions; it does not adopt a role.
- `/crew leave` releases the current member endpoint but keeps the base server online.
- `/crew stop` releases membership before stopping the base server.
- A live endpoint owned by another session is rejected and never overwritten. A link whose target is no longer live is stale and can be reclaimed by the next valid owner.
- Membership is branch-aware. Reload/resume restores the latest active identity after revalidation; new/fork branches with inactive state do not silently adopt it.
- `~/.pi/agent/crew.json` may contain `{ "startByDefault": true }` to start only the base server automatically. It does not select a crew member and does not bypass project trust.

Manifest fields are deliberately small: `version` must be `1`; each member needs a unique `name`, a non-empty `role`, and a `socket` path relative to the manifest that stays under `sockets/`; `instructions` is an optional string injected into that member's role context. Endpoint ownership is represented by symlinks under `.pi/crew/sockets/`, while internal UUID socket names remain implementation details.

## Usage

```bash
pi --crew
# shorthand
pi --in
```

Runtime commands:

```text
/crew join <socket>          # join a trusted crew member endpoint
/crew leave
/crew list                   # observe live sessions
/crew status
/crew stop
```

Crew membership is branch-aware and releases its endpoint on leave or stop. The canonical trusted layout is:

```text
.pi/crew/crew.json
.pi/crew/sockets/<member>.sock -> <running session socket>
```

`crew.json` is version 1 and maps each member to a unique name, role, and relative socket under `sockets/`:

```json
{"version":1,"members":[
  {"name":"lead","role":"lead","socket":"sockets/lead.sock"},
  {"name":"developer","role":"developer","socket":"sockets/developer.sock"},
  {"name":"qa","role":"QA","socket":"sockets/qa.sock"}
]}
```

The project must be trusted before the manifest is read. Endpoint symlinks are owned by the running session: live foreign endpoints are never stolen, stale links may be reclaimed, and leave/stop/shutdown release only links still pointing to the owner.

Startup can select identity directly with `--crew-socket <path>` (also starts intray); the path is reverse-resolved through the trusted manifest. At runtime, `/intray join <socket>` adopts a member, `/intray leave` releases it while keeping the base server online, `/intray status` reports identity, and `/intray stop` releases identity and stops the server. `~/.pi/agent/intray.json` may set `{\"startByDefault\":true}` for automatic base-server startup; it does not bypass project trust.

Sessions may be addressed by UUID or safe aliases:

- `/name` session aliases, when set.
- project + git branch aliases, assigned sequentially.

When joined to a trusted crew, the model can use `send_to_member({ member, message, mode?, wait_until?, reply_behavior? })` to address a unique member name or role over request-scoped RPC. `send_to_session` remains available for explicit UUID, alias, or repository-local socket targeting. For direct crew targeting, pass `socketPath` (optionally with a leading `@`) to `send_to_session`; it identifies the configured member endpoint, while `sessionId`/`sessionName` remain available for normal aliases.

## RPC

Newline-delimited JSON over the session socket:

- `{ "type": "send", "message": "...", "mode": "steer" | "follow_up" }`
- `{ "type": "status" }`
- legacy session control: `get_message`, `clear`, `abort`, and `subscribe(turn_end)`

RPC status reports `stopped`, `online`, or `joined`; request-scoped messaging and session control remain available over the UUID socket.

Startup CLI sends and direct `send_to_session` control remain supported.
