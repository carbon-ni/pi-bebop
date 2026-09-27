# Shared SDK migration

## Outcome

The CLI, Pi extension, and external Node.js consumers use typed SDK operations. A remote adapter calls an existing runtime over sockets. An in-process adapter calls the same runtime operations directly. Neither adapter creates a second owner of membership, authorization, request correlation, or Inbox state.

```text
CLI / external application -> SDK operation -> remote adapter -> source runtime
Pi tool                   -> SDK operation -> in-process adapter -> source runtime
                                                                     |
                                                        application/domain operations
```

The runtime may still contact another Member over a socket. No self-RPC means that a Pi tool does not contact its own source socket merely to reach its local application operation.

## Current evidence

Baseline: main `96fe084`.

- `src/sdk/index.ts` combines public types, validation, deadline/error handling, discovery and direct RPC calls.
- `src/cli/commands/member-status.ts` and `ask.ts` contain independent socket and result-handling paths.
- `src/tools/get-member-status.ts` uses `createMemberStatusFlow`; that application flow already owns trust, membership, target identity and cancellation policy.
- `src/extension.ts` composes runtime flows. Pi registration, event handling, prompt context, delivery and yielding are not portable SDK policy.
- CLI Ask currently returns a post-idle timeout where SDK Ask re-waits a pending outcome. Migration must not silently change either contract.
- Status is joined-Member-only today. Approved Guest request routes do not imply permission to query Member status.

Reuse the existing application layer; do not create another service layer that copies its decisions. The SDK boundary exposes operations, not generic raw RPC or a second runtime.

## Dependency rules

- Domain/application code must not import Commander, Pi APIs, or SDK presentation code.
- SDK operation contracts and in-process modules must not require a socket, filesystem discovery, environment variable, or Pi runtime object merely to import/use an operation.
- CLI owns parsing, help, output and exit codes; Pi owns tools, events, context, yielding and delivery hooks.
- Runtime owns mutable state and authorization. In-process dependencies come from trusted extension composition; a caller-supplied boolean must not grant membership.
- Use narrow typed operation dependencies. Do not add a generic `execute(method, args)` API or stubs for unsupported capabilities.
- Keep `@carbon-ni/pi-bebop/sdk` working. Add an in-process entry only when required. Independent npm packages or repositories are not needed for this refactor.

## Deliverables

Each row is one independently reviewable task/PR. Later tasks remain todo until their own exact-head gates pass.

| Task | Deliverable | Depends on |
| --- | --- | --- |
| TASK-0236 | Status operation contract, remote/in-process adapters and shared contract tests | TASK-0235 |
| TASK-0237 | CLI status consumes SDK | TASK-0236 |
| TASK-0238 | Pi status tool consumes in-process SDK | TASK-0236 |
| TASK-0239 | Last assistant message snapshot through shared SDK operation | TASK-0237, TASK-0238 |
| TASK-0240 | Non-interrupting Follow-up through both SDK adapters | TASK-0237, TASK-0238 |
| TASK-0241 | Durable Inbox through both SDK adapters | TASK-0240 |
| TASK-0242 | Request start/respond/wait primitives with one runtime registry | TASK-0240 |
| TASK-0243 | CLI Ask uses shared request orchestration with explicit timeout policy | TASK-0242 |
| TASK-0244 | Member idle wait with Pi wake/yield integration | TASK-0238 |
| TASK-0245 | Live Crew Broadcast using shared Follow-up operation | TASK-0240 |
| TASK-0246 | Redirect as an explicit SDK capability | TASK-0240 |
| TASK-0247 | Hard Interrupt as a separate explicit SDK capability | TASK-0246 |
| TASK-0248 | Read-only source/Crew discovery and authorized target resolution boundaries | TASK-0243 |
| TASK-0249 | Verify independent SDK entrypoints and completed migrations | TASK-0239 through TASK-0248 |

Start with TASK-0236. Status is read-only and lets us prove the adapter design before moving effectful operations. CLI and Pi status adoption are separate PRs, not hidden inside the foundation change.

## Required evidence for every migration

1. Characterize existing public behavior before changing implementation. Compare remote and in-process results/errors using the same deterministic scenarios where their authority is equivalent.
2. Cover happy/unhappy paths, identity mismatch, revoked authority, offline peers, deadlines and cancellation. Effectful operations also cover dispatch uncertainty and no automatic duplicate retry.
3. Check the real boundary as well as mocks: socket tests for remote behavior, in-process wiring tests proving no source self-RPC, and packed-consumer import/type tests when exports change.
4. Preserve text/JSON/TOON and Pi tool semantics. Document intentional differences instead of claiming full parity.
5. Verify source-disconnect and lifecycle invalidation behavior. Do not freeze membership/trust snapshots into a long-lived SDK client.
6. Record isolated watcher and GitHub evidence for the exact PR revision. Keep the task board in sync.

## Explicit exclusions

- No task bundling with open TASK-0179 / PR #44. Doctor integration can follow separately after its contract is settled.
- No revival of withdrawn TASK-0234 documentation/examples work.
- No automatic Guest admission, membership mutation, source identity borrowing, new permissions, cross-machine transport, or daemon.
- Crew setup, Guest administration, filesystem Intake, session capture/resume, and Pi lifecycle hooks are later candidates. Do not force them into this first migration.
- No requirement that every CLI command or Pi hook become an SDK method. Share reusable operations, not interface-specific mechanics.
