---
id: TASK-0053
title: Define deterministic crew init scaffold contract
status: done
depends_on: [TASK-0027,TASK-0039,TASK-0048]
priority: normal
tags: [crew, cli, init, scaffold, filesystem, axi, security]
---

# Define deterministic crew init scaffold contract

## Problem
Starting Bebop currently requires manually assembling .pi/bebop, crew.json, runtime directories, and optional role instructions. Define a safe, non-interactive, idempotent scaffold with clear ownership boundaries before adding filesystem mutation to the standalone CLI.

## Context

Proposed command:

```bash
pi-bebop crew init [--project <directory>] [--format toon|json|text]
```

Defaults:

- project: current working directory;
- canonical layout only: `.pi/bebop` (never generate compatibility `.pi/crew`);
- output: TOON;
- no prompts and no overwrite flag.

Initial software-crew scaffold:

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

`crew.json` is valid version 1 configuration with generic exact names `lead`, `product`, `developer`, and `quality`; matching roles/descriptions/instruction files; notifications enabled; and exact Intake contact `product`. Output tells user to review names/contact/instructions before starting member processes.

`.gitignore` excludes runtime-owned `sockets/` and private durable `inbox/`. Init creates empty `sockets/` for immediate discoverability but never creates socket links, member processes, Inbox records, session state, Git commits, or Pi trust decisions. Runtime creates `inbox/` only when needed.

## Mutation contract

- Preflight project and every managed path before writing.
- Missing target layout is created from deterministic versioned template bytes.
- Exact rerun returns successful `unchanged` with zero writes.
- Any existing/symlinked layout or differing managed file returns conflict with paths and actionable next step; no partial update or silent overwrite.
- Stage under same project `.pi` directory and atomically publish `.pi/bebop` so crash/concurrent init cannot expose partial scaffold.
- Failure cleans private staging directory without deleting user paths.

No `--force`: init is creation, not configuration migration. User must edit files normally or explicitly move/remove conflicting layout.

## Output contract

Structured success includes `status: created|unchanged`, project root, relative manifest path, created/verified relative paths, and next commands. Conflict/usage/operational errors use stable codes and never leak stack traces.

Exit codes:

- `0`: created or byte-identical no-op;
- `1`: filesystem/conflict/operational failure;
- `2`: usage error.

## Acceptance criteria

- [x] `pi-bebop crew init` contract is fully non-interactive and defaults to current directory, canonical `.pi/bebop`, and TOON output.
- [x] Only optional flags are `--project` and `--format`; command-local `--help` documents defaults, files, exit codes, and runnable create/no-op/conflict examples.
- [x] Generated file set and bytes are deterministic/versioned; LF output is independent of locale, time, user, Git, environment, or network.
- [x] Generated `crew.json` passes real manifest parser/loader, resolves all four `instructionsFile` values, and uses exact Intake contact `product`.
- [x] Generated instruction templates remain examples, define role mission/inputs/outputs/escalation/DoD, and stay aligned with maintained software crew workflow through one source or explicit drift test.
- [x] `.gitignore` excludes `sockets/` and `inbox/`; no socket symlink, Inbox item, process, session entry, Git operation, or trust decision is created.
- [x] Exact rerun is idempotent `unchanged` with no writes or metadata churn.
- [x] Existing different file, directory shape, symlink, non-directory project root, or unsupported path produces stable bounded error before managed mutation.
- [x] Conflict never overwrites user content; there is no force/merge/update behavior.
- [x] Publish is same-filesystem atomic and cleans staging after write/rename/concurrency failure without deleting pre-existing paths.
- [x] Concurrent initializers produce one valid scaffold plus deterministic created/unchanged outcome, never mixed files.
- [x] Default structured output is compact TOON; JSON is interoperability opt-in and text is human opt-in; stdout contains result/error, stderr only diagnostics.
- [x] Result uses project-relative managed paths and copyable next steps; no secrets, file contents, absolute home expansion, or raw dependency errors are emitted by default.
- [x] Usage validation rejects unknown/duplicate/missing/incompatible flags before filesystem dependencies are called.
- [x] Domain contract tests cover generated shape, manifest validity, deterministic bytes, output fields, no-op, conflict matrix, and path redaction.

## Out of scope

- Interactive questionnaire, custom names/roles, compatibility `.pi/crew` generation, force/merge/migration, editing existing manifests, starting Pi/member sockets, installing extensions, Git initialization/commit, project trust, external Intake send, or arbitrary templates.

