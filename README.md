# Pi Bebop

Give a small dysfunctional crew to your Pi agents. Bebop is self-contained: it
owns its crew socket transport, project-local membership, and role-based
`send_to_member` delivery.

## Setup

Create the crew manifest in a trusted project:

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

> This is why it is a dysfunctional crew: members may or may not be there, by
> design. You can create a script to start the crew yourself.

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
