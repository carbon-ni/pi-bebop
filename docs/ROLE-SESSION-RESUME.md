# Role Session Resume contract

Status: proposed implementation contract for TASK-0205 through TASK-0207.

## Promise

`pi-bebop session resume --role <exact-role>` is a separate Bebop picker for a
current trusted Crew. It shows only prior Pi sessions that Bebop explicitly
attributed to the exact current configured Member for that role. Selecting one
launches that exact existing Pi session and its history.

```text
pi-bebop session resume --role developer
```

Plain `pi -r` remains unchanged and unfiltered.

## Exact resume

On confirmation, Bebop starts:

```text
pi --session <absolute-session-file>
```

with the selected session's stored working directory and inherited terminal
streams. Bebop does not create, fork, clone, reconstruct, rename, or write the
selected session. It adds no `--crew-role`, `--crew-socket`, model, prompt, or
thinking arguments. Pi remains responsible for opening the history; Bebop's
normal persisted Membership lifecycle then validates and restores its own
state.

## Attribution and scope

At each successful Member join, Bebop appends a versioned custom membership
entry to that Pi session's active branch. The entry snapshots the configured
Member name and role plus canonical Crew locator and manifest fingerprint.
The snapshot does not contain conversation content, credentials, or role
instructions.

The picker resolves the requested role from one current project-local trusted
manifest using the existing exact unique-role rule. A candidate must have an
active attribution snapshot whose Member identity, canonical locator, and
fingerprint exactly match that current Crew. It is not enough for the current
manifest to have a similarly named role.

Bebop discovers candidates through public Pi `SessionManager.listAll()` and
`SessionManager.open()` APIs and reads only extension custom state on each
session's active branch. It does not parse raw JSONL, infer from timestamps,
filenames, prompts, names, or current role assignments. Sessions without the
new durable snapshot are intentionally unavailable.

## Safety outcomes

- **cancelled:** launch nothing; change no session or Membership state.
- **empty:** no matching attributed session; never fall back to a fresh or
  unrelated Pi session.
- **stale or invalid:** missing file/cwd, untrusted root, malformed header,
  ID/cwd mismatch, inactive Membership, or manifest drift is refused.
- **already online:** if the current exact Member endpoint is live, refuse to
  launch a second writer for that Member's JSONL.

The picker validates the selected file/header/root/cwd and probes the endpoint
again immediately before launch. This is an observation, not a lock; normal
process races remain explicit.

## Boundaries

Role Session Resume is distinct from a **Crew Session**. The existing Crew
Session contract stays an explicit captured multi-member bookmark with manual
one-member resolution. Role Session Resume is a single-role, current-Crew
history selector. It does not restore a whole Crew or repair old history.
