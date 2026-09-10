# Crew Session contract

Status: normative product contract for TASK-0200. Capture, inspection, and
manual resolution are separate implementation tasks. This contract defines the
identity and safety boundary they must preserve.

## Promise

A Crew Session is a durable, machine-local bookmark for the exact Pi Session
that represented each configured Member at one explicit capture moment. It lets
a user inspect and manually reopen Members one at a time after processes close.
It is not a shared conversation, a process group, a task, a workflow, or a
liveness claim.

```text
# While the intended Members are online:
pi-bebop session capture "auth regression"

# Later, after processes or tabs close:
pi-bebop session list
pi-bebop session show <crew-session-id>
pi-bebop session resolve <crew-session-id> <member>
# The user runs the returned exact Pi command in a chosen terminal.
```

`pi-bebop crew session ...` is no longer supported; it returns `UsageError` with
the replacement hint `pi-bebop session <capture|add|list|show|resolve>` (TASK-0204).

Bebop never launches the whole Crew, opens a terminal, chooses a latest or
most-recent session, or infers a relationship from timestamps, branches, roles,
conversation content, or copied extension entries.

## Terms and boundaries

| Term | Contract meaning | Not this |
| --- | --- | --- |
| **Pi Session** | Pi's persisted JSONL conversation, identified by its exact full session ID and Pi-owned session metadata: persisted file, working directory, and SessionManager-reported root. Bebop treats the conversation body as opaque. | Crew identity, Member identity, a Bebop record, or a transcript that Bebop may parse |
| **Crew Session** | One named, machine-local record linking one exact Crew to zero or more captured configured Members and their exact Pi Sessions. | Shared conversation, running process group, workflow, task, lock, or availability claim |
| **Member Session link** | One immutable-at-capture binding of Crew identity, exact configured Member name/role, and exact persisted Pi Session identity plus safe reopen metadata. | A guessed latest session, a role-to-session inference, or a copy of conversation content |
| **Crew Session capture** | An explicit snapshot of currently joined, online Members belonging to one exact trusted Crew. It records valid links and named missing reasons; it never silently omits Members. | Automatic shutdown behavior, history scan, session picker, or whole-Crew launcher |
| **Member Session addition** | An explicit operation that captures one previously missing exact Member into an existing partial Crew Session without changing any other link. | Replacement of an existing binding or an implicit recapture |
| **Member Session resolution** | A read-only validation of one stored link that returns evidence and a manual Pi startup specification. | Starting Pi, claiming a lock, repairing history, or guaranteeing another process will not open the file |
| **Manifest fingerprint** | A versioned digest of the canonical, schema-validated Crew identity and Member routing metadata observed at capture. It detects drift without storing manifest content. | Crew identity, a credential, or proof that a session is still running |
| **Session reference** | Explicit-command-only metadata required to validate or manually reopen one link: full Pi Session ID, persisted file, cwd, and supported SessionManager root evidence. | Default Crew/member/status/list output |

A Crew Session has its own generated ID and human name. The generated ID is the
stable exact selector for `show` and `resolve`; the human name is a display
value and is never a target selector. Duplicate names therefore remain
separate and require the exact ID.

## Record contract

Records are versioned so future readers can reject unknown shapes rather than
reinterpret them. A valid record contains:

- a stable generated ID that is non-empty, opaque, and not derived from a
  session ID or timestamp;
- a non-empty human name with bounded length;
- exact Crew identity: the public Crew Selector when present, the explicit Crew
  Locator used for capture, and the versioned manifest fingerprint;
- `createdAt` as an RFC 3339 UTC instant;
- configured Members in manifest order, including one row for every expected
  Member; and
- either a captured link or a bounded missing reason for each row.

A captured link contains only the metadata needed for later validation and
manual reopening:

- exact configured Member name and configured role;
- exact full Pi Session ID;
- the persisted session-file reference;
- the session working directory and SessionManager-reported session root; and
- the capture instant as an RFC 3339 UTC value.

A record never stores conversation messages, prompts, transcript summaries,
credentials, provider tokens, opaque capabilities, Inbox content, or Role
instruction text. Session references are still sensitive local metadata and
are disclosed only by explicit Crew Session commands or diagnostics.

`manifestFingerprint` is versioned (for example, `mfv1-sha256-...`) and is
computed from deterministic canonical JSON containing the schema version,
Crew Selector/display identity, Member names/roles/endpoints in manifest order,
and relevant membership policy. Key order and representation are canonical;
instruction file contents, runtime sockets, capabilities, and credentials are
excluded. The exact canonicalization and digest version are part of the stored
schema, so drift is detected without pretending that a digest authenticates a
caller.

A capture record is `complete` when every configured Member has a valid link and
`partial` when at least one link is valid and every other Member has an explicit
missing reason. A zero-valid-link capture returns `capture-empty`, exits 1, and
writes no record.

## Explicit capture and addition

Capture requires an exact trusted Crew. An explicit current-project Crew
Locator is sufficient; it must not first discover the Crew through TASK-0172's
Crew directory or a public selector. A public selector may be added later
without changing the link identity.

Capture is performed in manifest order and queries each configured Member only
through a purpose-specific trusted local capture operation. A Member is
capturable only when the response proves all of the following:

1. the endpoint belongs to the exact trusted Crew Locator and configured Member;
2. the active Pi session is currently joined as that Member;
3. Pi's public SessionManager reports a full session ID, persisted file, cwd,
   and session root for that active session; and
4. the persisted session passes the session-file and header checks in the
   security section below.

Generic status, roster, and message APIs do not gain private Pi Session fields
for this feature. Each failed Member remains in the record with one stable
reason such as `offline`, `unavailable`, `unpersisted-session`,
`malformed-session`, `wrong-crew`, `wrong-member`, `untrusted-session-root`,
`missing-session-file`, `capture-timeout`, or `capture-aborted`. Reasons are
bounded and must not include raw dependency errors or file contents.

Capture does not guess or substitute a session. It never selects a recent file,
uses a timestamp, follows a copied extension entry, or falls back from a
custom session root to a default root. At least one valid link is required for
an exit-0 `complete` or `partial` record.

`session add <crew-session-id> <member>` requires the exact stable Crew
Session ID and exact case-sensitive configured Member name. It validates and
captures only that previously missing Member. It is atomic: existing links,
missing reasons, name, Crew identity, and capture history are not rewritten by
an addition. Repeating the same binding is an unchanged success. A different
binding for an already captured Member returns `member-already-bound`; replacing
it is deliberately unavailable and requires a new Crew Session.

Exact recapture of the same name and same Member bindings is idempotent. A
second record with a duplicate human name is allowed to exist, but any command
that starts from a name must return bounded ambiguity with candidate exact IDs;
no first/most-recent choice is permitted.

## Storage and write safety

Crew Session records live outside repositories and manifests in the dedicated
machine-local control directory:

```text
$BEBOP_CONTROL_DIR/crew-sessions/
# On the default POSIX installation: ~/.pi/bebop/crew-sessions/
```

`crew init` and other scaffold commands never create this directory. Capture
may create it only as part of an explicit valid capture. On POSIX, the root is
created with mode `0700`, records with mode `0600`, and both must be owned by
the current user. A symlink, foreign owner, group/world-writable root, or
group/world-writable record fails closed. Equivalent platform ownership and
permission checks apply where POSIX metadata is unavailable.

Publication uses a private same-directory staging file, restrictive mode,
flush/fsync where supported, and an atomic rename. Staging files are removed on
failure. Capture and addition serialize or reject concurrent updates
deterministically; neither operation may lose another successful link or
publish a partially written record. Record reads never repair, delete, rewrite,
or update mtimes.

## Pi Session identity and trust

Bebop uses only supported public Pi lifecycle contracts. Before accepting a
link, the active SessionManager must provide the exact full session ID,
persisted session file, session cwd, and canonical session root. Supported
`SessionManager.open` and header APIs validate the binding and full header ID.
If the installed Pi package cannot provide a required field through a stable
public API, implementation stops with an explicit integration dependency; it
does not parse private JSONL or guess from filenames.

The session file must be a regular non-symlink file beneath the canonical root
reported by that active SessionManager. The root and every path component are
canonicalized and checked for descendant containment, current-user ownership,
and absence of group/world write. Custom roots are allowed only when the active
Pi reports that exact root and all checks pass. An absent or untrusted custom
root fails as `untrusted-session-root`; Bebop never falls back to a default
root or scans the user's home directory.

A copied or forked worktree cannot steal a link by copying extension entries.
Later validation requires the stored full header session ID, the stored Crew
and Member identity, the trusted manifest fingerprint/Locator, and the current
SessionManager evidence. A different header or Crew is a mismatch, not a new
binding.

Closing a Pi process preserves the record. Later list/show/resolve operations
report missing files, moved worktrees, explicit Crew leave, manifest drift,
changed endpoint, deleted session, or an already-open session as distinct
bounded observations. History is never silently rebound, migrated to a new
manifest, or deleted because a process closed.

## Inspection and manual resolution

`session list` is read-only and returns bounded records in deterministic
ID order, with total/returned/truncation metadata. Its default fields are ID,
name, Crew public identity, capture time, expected/captured counts, and one of
`complete`, `partial`, `stale`, or `invalid`. An empty result includes the
copyable next step `pi-bebop session capture <name>`.

`session show <crew-session-id>` requires the exact stable ID and returns
manifest-order Member rows. It validates record schema and integrity without
opening conversation bodies. It may show explicit session reference fields
needed for inspection, current cwd/session-file availability, active-process
observation, membership/manifest drift, and one terminal reason. Corrupt rows
are isolated as `invalid`; one bad record never hides healthy records.

Resolution of one Member validates the record, trusted Crew, exact configured
Member, stored full session ID, SessionManager root and header, cwd, persisted
membership evidence, and current process observation. It returns structured
argument and cwd fields separately. Text may additionally render one
correctly shell-escaped command using Pi's supported exact behavior:

```text
pi --session <absolute-session-file>
```

The user, not Bebop, runs that command. Resolution never launches Pi, opens a
terminal, modifies session JSONL, copies conversation content, or starts the
whole Crew. An `already-open` observation refuses a normal resume command because
two writers to one JSONL are unsafe. Every resolution is an observation, not a
lock: another process may open the file after validation and before the user
runs the command, and Bebop must not claim otherwise.

Persisted membership restore remains Pi's lifecycle responsibility. Bebop
revalidates its own trusted manifest and Member context when the resumed Pi
session joins; it does not add `--crew-role`, socket flags, model settings,
thinking settings, prompts, or private repair instructions to the startup
specification.

## CLI result contract

The commands default to deterministic TOON. `--format json` and
`--format text` are explicit alternatives with the same semantic states,
reasons, counts, and truncation metadata. Text is concise and actionable;
structured output keeps paths and IDs in explicit fields rather than an
interpolated shell command.

| Situation | Exit | Required result |
| --- | ---: | --- |
| Record created, unchanged, or safely extended with one valid link | 0 | `complete` or `partial` with counts and every missing reason |
| Valid list/show observation, including stale or isolated invalid rows | 0 | Bounded observation; no automatic repair |
| Zero-valid-link capture | 1 | `capture-empty`; no record written |
| Offline, unavailable, stale, invalid, missing, drift, already-open, or operational failure | 1 | Stable reason and one safe recovery |
| Missing/unknown/duplicate argument or unsupported flag | 2 | Usage error before manifest, socket, session, or storage IO |
| Caller cancellation | 130 | `cancelled`; local work stops without claiming target cancellation |

Normal Crew, Member, Presence, Activity, Status, and routing output continues
to hide full Pi Session IDs, files, cwd, session roots, and record internals.
Only explicit Crew Session commands and opt-in safe diagnostics disclose the
bounded references required for this workflow. Diagnostics never expose
conversation content, credentials, provider tokens, Inbox content, Role
instructions, runtime sockets, or opaque capabilities.

## Non-goals

This contract does not launch terminals, resume the whole Crew, start
background agents, copy or export conversations, synchronize to a service,
share records across users, choose a recent session, manage tasks, or change
Pi's JSONL/session semantics.
