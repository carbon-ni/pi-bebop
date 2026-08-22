# Pi Bebop

Give a small dysfunctional crew to your Pi agents. Bebop is deliberately layered
on top of the separately installed `pi-intray` extension: intray owns generic
session transport, `send_to_session`, `list_sessions`, and `--intray`; Bebop
owns trusted, project-local crew identity and `send_to_member`.

## Setup

Create the crew manifest in a trusted project:

```bash
mkdir -p .pi/intray/sockets
cat > .pi/intray/crew.json <<'JSON'
{"version":1,"members":[
  {"name":"lead","role":"lead","socket":"sockets/lead.sock"},
  {"name":"developer","role":"developer","socket":"sockets/developer.sock"}
]}
JSON
```

The project must be trusted by Pi before this manifest can be read. Trust is a
project security boundary, not a property granted by the filename or socket
path.

> This is why it is a dysfunctional crew: members may or may not be there, by
> design. You can create a script to start the crew yourself.

Start each member with intray's transport flag and Bebop's crew flag:

```bash
pi --intray --crew-socket "$PWD/.pi/intray/sockets/lead.sock"
pi --intray --crew-socket "$PWD/.pi/intray/sockets/developer.sock"
```

`--crew-socket` selects a member from the trusted manifest; it does not start a
socket server. `--intray` must therefore be provided (or intray must be
otherwise configured to start).

For an existing session, join a crew endpoint with:

```text
/crew join .pi/intray/sockets/lead.sock
```

Use `/crew status`, `/crew leave`, or `/crew stop` to inspect or release the
current identity.

## Role-based messaging

Once joined, use Bebop's only tool:

```text
send_to_member({
  "member": "developer",
  "message": "Please confirm the endpoint is working.",
  "wait_until": "turn_end",
  "reply_behavior": "end_conversation"
})
```

Members can be addressed by unique name or role. A live endpoint owned by
another session is never overwritten; stale endpoints may be reclaimed.

For generic session discovery, direct session messaging, and intray CLI flags,
use `pi-intray` directly.
