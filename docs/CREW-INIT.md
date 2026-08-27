# Crew Init

`pi-bebop crew init` is the deterministic, non-interactive scaffold that
creates a canonical software crew layout in a project. It is creation, not
configuration migration: it never overwrites, merges, or forces.

> TASK-0053 defines the contract (managed layout, deterministic versioned
> template bytes, preflight/conflict decision, output and exit-code contract,
> usage validation, path redaction). The CLI wiring and filesystem mutation
> are TASK-0054 and are not implemented by this task.

## Command

```text
pi-bebop crew init [--project <directory>] [--format toon|json|text]
```

Defaults:

- `--project`: current working directory;
- canonical layout only: `.pi/bebop` (never compatibility `.pi/crew`);
- output: TOON;
- no prompts and no `--force`.

## Managed layout

```text
.pi/bebop/
├── .gitignore
├── crew.json
├── instructions/
│   ├── common.md
│   ├── lead.md
│   ├── product.md
│   ├── developer.md
│   └── quality.md
└── sockets/
```

- `crew.json` is valid version 2 configuration with generic exact names `lead`,
  `product`, `developer`, and `quality`; matching roles, descriptions, a shared
  `commonInstructionsFile`, and role `instructionsFile` values under
  `instructions/`; notifications enabled; exact Intake contact `product`.
  Review names, contact, common guidance, and role instructions before starting
  member processes.
- `.gitignore` excludes runtime-owned `sockets/` and private durable `inbox/`.
- Init creates empty `sockets/` for immediate discoverability but never creates
  socket links, member processes, Inbox records, session state, Git commits, or
  Pi trust decisions. Runtime creates `inbox/` only when needed.

## Manual layout

The same layout can be authored by hand or scripted; the minimal manifest is
version 1 with exact member names/roles and socket-relative paths:

```json
{
	"version": 1,
	"members": [
		{ "name": "lead", "role": "lead", "socket": "sockets/lead.sock" },
		{ "name": "developer", "role": "developer", "socket": "sockets/developer.sock" }
	]
}
```

Version 2 may select one shared `commonInstructionsFile`, applied to every
member, while each member may use either inline role instructions or a Markdown
file, never both. All file paths stay beneath the active layout's `instructions/`
directory and are rejected on symlink escapes, directories, invalid UTF-8, NULs,
blank files, or files over 64 KiB. `AGENTS.md` remains project-wide agent
guidance; `common.md` is shared crew collaboration guidance; role files define
member-specific responsibilities. Current Crew Agreements remain separate and
may be selected in version 2 with `crewAgreements.file`, rooted under the
active layout's `agreements/` directory. The trusted loader snapshots agreement
bytes for every member before claim and renders them between Common and Role
sections; section order grants no override authority. Agreement files use the
same strict 64 KiB UTF-8/NUL/blank/regular-file/real-path checks and fail before
claim. Files are read once during startup, restore, or explicit join/rejoin (no
hot reload; leave and rejoin to refresh):

```json
{ "name": "Bob", "role": "developer", "socket": "sockets/Bob.sock", "instructionsFile": "instructions/developer.md" }
```

Descriptions are short, stable, crew-visible profiles for choosing an exact
member when roles repeat — never routing keys, permissions, role instructions,
or current work. Keep them to one non-secret line:

```json
{
	"name": "Bob",
	"role": "developer",
	"description": "Builds domain and application changes",
	"socket": "sockets/Bob.sock"
}
```

`/crew members` renders the authoritative roster for the active membership:
configured project socket paths and exactly `current`, `online`, or `offline`;
global UUID destinations, aliases, and full instructions are never shown. The
current member is identified from membership without probing; other endpoints
are probed independently. Unjoined, `/crew members` prints `Crew not joined.
Use /crew join <socket>.` with no discovery and no agent turn.

```text
Crew: /project/.pi/bebop/crew.json
Members (3):
- lead (lead) — current — /project/.pi/bebop/sockets/lead.sock
- Bob (dev) — online — /project/.pi/bebop/sockets/Bob.sock
- Kelly (qa) — offline — /project/.pi/bebop/sockets/Kelly.sock
```

## Mutation contract

- Preflight the project and every managed path before writing.
- Missing target layout is created from deterministic versioned template bytes.
- Exact rerun returns successful `unchanged` with zero writes.
- Any existing/symlinked layout or differing managed file returns a conflict
  with the offending relative path and an actionable next step; no partial
  update and no silent overwrite.
- Publish is same-filesystem atomic and cleans staging after
  write/rename/concurrency failure without deleting pre-existing paths.
- No `--force`: init is creation, not configuration migration.

## Output contract

Structured success includes `status: created|unchanged`, project root, relative
manifest path, created/verified relative paths, and next commands. Conflicts,
usage, and operational errors use stable codes and never leak stack traces,
secrets, absolute home expansion, or raw dependency errors.

Exit codes:

- `0`: created or byte-identical no-op;
- `1`: filesystem/conflict/operational failure;
- `2`: usage error.

## Relationship to other signals

- Crew contact is the exact manifest member triaging external Crew Intake; it
  is not lead, manager, authority, default internal recipient, or permission.
- Internal member communication still targets an exact member name or unique
  role through existing tools; init never auto-routes through the contact.
- The scaffold reflects the maintained software crew workflow
  (`docs/SOFTWARE-CREW-WORKFLOW.md`); templates are examples, not permissions.
