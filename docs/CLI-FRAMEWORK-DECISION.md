# CLI framework decision (TASK-0056)

Status: **decision recorded** — defines the future implementation task; no
dependency added to production yet.

## Selected: Commander (v15.0.0, pinned, MIT, zero runtime deps)

Commander is the only candidate that preserves the deterministic AXI contract
with catchable errors and app-owned exit assignment:

1. **Validation before IO** — `exitOverride()` turns every parse failure
   (unknown flag, unknown command, missing value, excess positionals) into a
   throwable `CommanderError` with `code` + `exitCode`; the app intercepts and
   assigns `usage` (exit 2) before any fs/network access. citty swallows all
   parse errors (`strict: false` internally) and runMain hardcodes exit 0/1.
2. **Structured usage on stdout, silent stderr** — `configureOutput` routes
   library writes to no-ops; the app renders its own TOON/JSON/text usage
   result. No framework diagnostics reach stdout/stderr (verified in spike).
3. **No implicit process exit** — with `exitOverride()`, parse and even
   `--help` throw; the app owns `process.exitCode`. citty's `runMain` calls
   `process.exit()` directly.
4. **Deterministic help, no ANSI** — Commander help is plain text when piped.
   citty and cleye emit ANSI escape codes unless `NO_COLOR=1`/`TEST`/`CI` env
   is set — an env-dependent output violation.
5. **No double-run bug** — citty's `runCommand` executes the parent command's
   `run` even after a subcommand ran (verified: `send` output followed by home
   output). Commander dispatches to exactly one action.
6. **Node 22** — engines `>=22.12.0`; repo runs Node v22.20 (satisfied).

## Evidence (spike, 2026-08-26, `.tmp/cli-spike/`)

| Criterion                           | citty 0.2.2                       | Commander 15.0.0                           | Cleye 2.6.0                     |
| ----------------------------------- | --------------------------------- | ------------------------------------------ | ------------------------------- |
| License                             | MIT                               | MIT                                        | MIT                             |
| ESM                                 | yes                               | yes                                        | yes                             |
| Engines                             | none declared                     | node >=22.12.0                             | none declared                   |
| Runtime deps                        | 0                                 | 0                                          | 2 (type-flag, terminal-columns) |
| Tarball size                        | 10,298 B                          | 52,736 B                                   | 24,621 B                        |
| Minified bundle delta (parse spike) | +3,982 B                          | +39,177 B                                  | +41,901 B                       |
| Unknown flag                        | **silently accepted**             | CommanderError (catchable)                 | **silently accepted**           |
| Duplicate flag                      | last wins silently                | last wins silently                         | last wins silently              |
| Unknown command                     | runMain exits(1), error on stderr | CommanderError excessArguments (catchable) | n/a (not spiked)                |
| Missing value                       | swallowed                         | CommanderError optionMissingArgument       | n/a                             |
| `--flag=value`                      | works                             | works                                      | works                           |
| `--` sentinel escape                | not supported                     | not supported (different semantics)        | n/a                             |
| No implicit process exit            | ✗ runMain exits                   | ✓ exitOverride throws                      | n/a                             |
| Help ANSI when piped                | **yes** (env-dependent)           | **no (plain)**                             | **yes**                         |
| Parent run after subcommand         | **yes (bug)**                     | no                                         | n/a                             |

Current baseline bundle: 356,717 B (`dist/cli/main.js`); packed tarball
210,672 B. Commander adds ~39 KB (~11%) to the bundled CLI.

## Required app-owned pre-pass (cross-flag validation stays outside the framework)

Both candidates silently last-win on duplicate flags and do not implement the
current `--message -- --content` sentinel escape. The implementation task must
keep a small raw-args pre-pass (scan for repeated flags; rewrite sentinel
values) before delegating tokenization to Commander — this is the same
"application calls, cross-flag/domain validation, trust/path policy, output
rendering, IO, exit assignment stay outside the framework" boundary the plan
already declares.

## Rejected alternatives

- **citty 0.2.2** — smallest footprint and zero deps, but: swallows all parse
  errors (unknown flags can never be rejected by the library), parent `run`
  double-fires after subcommands, help emits ANSI unless env flags are set, and
  `runMain` hardcodes exits. Would require fully hand-rolled validation and
  exit handling on top, defeating the framework's purpose.
- **Cleye 2.6.0** — typed flags and clean DX, but: silently accepts unknown
  flags, ANSI help when piped, largest bundle, two runtime deps, and
  `type-flag` semantics diverge from the locked contract.
- **Keeping the hand-written parser** — viable and currently passing, but the
  task exists because it is high-complexity, single-command, and hard to
  extend to nested subcommands; framework adoption is deferred to a separate
  implementation task after this contract is locked.

## PO sequencing review incorporation (2026-08-26, `.tmp/reports/23-08-26/task-0056-0067-plan-sequencing-review.md`)

Three contract implications were incorporated before freezing the CLI contract;
the first two are additionally locked by tests in `src/cli/cli-contract.test.ts`
(tests 21–23).

### 1. Per-action isolation and one owned registry (unblocks 0062/0064..0067)

Every command/action is implemented as an **isolated per-action module** holding
its own schema + handler, published through **one explicitly owned integration
registry** (`src/cli/registry.ts` at implementation time). Shared protocol/dispatch
files (RPC tagged union, source-session server dispatch, output mapping, packaged
CLI verification) are never extended directly by a slice. This is the required
decision from the PO review: downstream slices either land through the registry
seam or are serialized — concurrent crew execution must never overlap central
dispatcher/parser files and produce inconsistent tagged unions. Command tree
declarations stay in per-action modules; the registry is the only owner of
command-tree composition.

### 2. One shared `--timeout` duration grammar; boundary winner defined

`send --timeout` is duration-valued (`500ms|30s|5m`, `parseCliArguments`
`duration()`). TASK-0067 must **not** redefine it as bare seconds — locked by
contract test: `--timeout 600` (bare seconds) is a usage error; `--timeout 10m`
parses to 600000 ms; `--timeout 1s` to 1000 ms. Any new duration-valued flag in a
future command reuses this same grammar (command-shared, never meaning-changes
by command).

**Boundary winner:** the future idle-wait implementation distinguishes a short
**connection/setup deadline** (internal, bounded, separate from user flags) from
the **idle operation deadline** (user-visible `--timeout`). The first deadline to
fire wins; on simultaneous expiry the **idle operation deadline** is reported
(its outcome is the one the caller asked for), and the connection/setup deadline
only surfaces as the terminal result when connection/setup itself did not
complete before it. Neither deadline is implicit — both are bounded and
terminate the wait deterministically.

### 3. `--session` placement, precedence, and self-correcting discovery

`--session` is **not a global/root flag today** (contract test 22 locks both
error shapes: leaf position is `Unknown flag '--session'`, root position is
`Invalid command`). TASK-0060 must add it as an explicit tested contract
decision with: **leaf-command-local placement only** (after the selected leaf
command, before any `--` terminator), explicit precedence (nonblank explicit
flag > `PI_SESSION_ID` fallback, which accepts only a safe exact session id),
and **self-correcting target discovery** — unknown/missing/offline/unjoined
sources fail before member-action IO and the error includes a copyable next
step (a compact `session list` discovery command or one documented
deterministic acquisition path).

## Ownership / policy (AC 9)

- **Dependency ownership**: Commander becomes a production dependency of the
  standalone CLI only in the implementation task; extension/domain layers stay
  framework-free.
- **Version pinning**: exact pin `commander@15.0.0` (or later audited minor in
  a locked package-lock), verified in `verify-package.mjs` packed-CLI gate.
- **License**: MIT (compatible with the project).
- **Build/package inclusion**: bundled by `scripts/build.mjs` into
  `dist/cli/main.js`; `verify-package.mjs` must assert the CLI still runs from
  the packed artifact with identical vocabulary.
- **Upgrade policy**: upgrades only via a dedicated task that re-runs the
  characterization suite (`src/cli/cli-contract.test.ts`) plus the spike exit/
  stream checks; any behavioral delta is an explicit tested contract decision.
