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
│   ├── lead.md
│   ├── product.md
│   ├── developer.md
│   └── quality.md
└── sockets/
```

- `crew.json` is valid version 1 configuration with generic exact names `lead`,
  `product`, `developer`, and `quality`; matching roles, descriptions, and
  `instructionsFile` values under `instructions/`; notifications enabled; exact
  Intake contact `product`. Review names, contact, and instructions before
  starting member processes.
- `.gitignore` excludes runtime-owned `sockets/` and private durable `inbox/`.
- Init creates empty `sockets/` for immediate discoverability but never creates
  socket links, member processes, Inbox records, session state, Git commits, or
  Pi trust decisions. Runtime creates `inbox/` only when needed.

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
