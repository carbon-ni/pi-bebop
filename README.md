# Pi Bebop

<img  width="250" alt="screenshot-2026-08-22_15-39-54" src="https://github.com/user-attachments/assets/9430855c-9060-4f1f-b7a8-e8d3b03ce232"  align="left"  />


Give a small dysfunctional crew to your Pi agents. Bebop is self-contained: it
owns its crew socket transport, project-local membership, and intent-based
`send_follow_up`/`send_immediate` delivery.


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

### The crew

> This is why it is a dysfunctional crew: members may or may not be there, by
> design. You can create a script to start the crew yourself.

A socket under `.pi/bebop/sockets/` selects only `.pi/bebop/crew.json`; a socket under `.pi/crew/sockets/` selects only `.pi/crew/crew.json`. There is no fallback or merge when both manifests exist. Other `.pi/<name>/crew.json` paths are rejected as untrusted, and missing, malformed, or member-mismatched manifests report their actionable cause.

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
current identity. The configured socket name is authoritative (including
extensionless names); `dev` is not silently changed to `dev.sock`.

Selections may target another trusted worktree from the current project. Both
startup and runtime commands use the manifest adjacent to the absolute endpoint
and never consult the current working tree's manifest:

```bash
pi --crew-socket /worktree-B/.pi/bebop/sockets/dev1.sock
# in an existing session:
/crew join /worktree-B/.pi/crew/sockets/dev1.sock
```

## Direct socket messaging from a shell

The package also installs `pi-bebop`, which targets one endpoint directly. It does
not read the crew manifest or resolve names and roles:

```bash
pi-bebop send --socket .pi/bebop/sockets/lead.sock \
  --message "Review the current changes"
printf 'line one\nline two\n' | pi-bebop send --socket .pi/crew/sockets/lead.sock --stdin --wait accepted --format json
```

The default is `--mode steer`, `--wait turn_end`, `--timeout 5m`, and `--format
 toon`. Repeat `--instruction <text>` to attach ordered user-level instructions, and
use `--from <label>` for explicitly claimed external attribution (never verified
crew identity). `--instruction` values are bounded by the shared UTF-8 payload
limits; missing values and blank labels are usage errors. Stdin is content only.
Use `--wait accepted` for acknowledgement-only automation, `--format text`
for concise human output, and `--full` to disable the 2,000-character response
preview. JSON and TOON always include `ok`, `target`, `status`, and response/error
data; exit status is 0 for success, 1 for operational failures, and 2 for
invalid usage. The CLI never attaches callback metadata unless a caller explicitly uses the
session tool; `--from` is attribution only and never a reply route.

Release/package verification is intentionally separate from quick tests because it installs a pinned consumer dependency set and may require network or a warm npm cache:

```bash
make package-verify
# equivalent: npm run verify:package
```

The quick test suite only packs/extracts locally and runs the bundled CLI; it does not perform registry IO.

A Unix socket is a local capability. The effective boundary is permission to
traverse its parent directories and connect to the socket (subject to the
platform's Unix-socket permissions), not secrecy of the path. Path knowledge
alone is not an authentication mechanism. Direct targeting supports both
`.pi/bebop/sockets/*` and `.pi/crew/sockets/*`; no manifest or role lookup is
performed. Malformed RPC payload classification remains a transport concern
tracked for TASK-0024; this CLI currently reports the shared transport timeout.

## Role-based messaging

Once joined, use `send_follow_up` by default:

```text
send_follow_up({
  "member": "developer",
  "message": "Please confirm the endpoint is working."
})
```

Use `send_immediate` only when the message should redirect active work. Both
return an accepted delivery acknowledgement with `deliveryId` and disposition
(`direct`, `queued`, or `steered`). `wait_for: response` is explicitly
unsupported because Pi lifecycle events cannot prove delivery-level response
correlation; it never consumes an unrelated global `turn_end`. Members can be
addressed by unique name or role. A live endpoint owned by another session is
never overwritten; stale endpoints may be reclaimed.
