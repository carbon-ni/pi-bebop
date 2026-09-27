# SDK interface and ownership map

The SDK shares typed capabilities, not runtime state or generic RPC.

## Public boundaries

| Capability                            | Public entry                                         | Remote owner                     | In-process owner                                                 | CLI/Pi difference                                                                                            |
| ------------------------------------- | ---------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Source list/select                    | `createBebopClient().listSources/selectSource`       | Source socket status probe       | Not used; Pi receives live runtime dependencies                  | CLI/external callers select an explicit source or `PI_SESSION_ID`; Pi tools use current composition identity |
| Member status                         | `MemberStatusOperation`                              | Joined trusted source runtime    | `createInProcessMemberStatusOperation`                           | CLI renders process output; Pi renders tool output                                                           |
| Last message                          | `MemberLastMessageOperation`                         | Joined trusted source runtime    | `createInProcessMemberLastMessageOperation`                      | CLI-only consumer today                                                                                      |
| Follow-up, Redirect, Inbox, Broadcast | Typed operation factories                            | Existing source RPC/runtime flow | Existing application flow with live membership/trust/Guest reads | CLI owns parsing/output; Pi owns tool/event delivery                                                         |
| Request/Ask                           | Request lifecycle factories and `createAskOperation` | Source request registry          | Runtime request flow                                             | SDK re-waits pending outcomes; CLI intentionally reports post-idle timeout                                   |
| Crew target routing                   | `createCrewTargetResolver` (application)             | Canonical owner probe            | Trusted runtime composition                                      | CLI may discover manifests/routes; Pi never borrows a discovered Member as caller                            |

## Ownership rules

- `src/sdk/source-discovery.ts` owns bounded filesystem enumeration, alias canonicalization, source status probes, and explicit source selection. It never creates membership or trust.
- `src/application/crew-target-resolution.ts` owns trusted manifest selection, manifest-authored contact, canonical owner revalidation, ambiguity/conflict handling, and Member/Guest authorization. Discovery metadata is not authority.
- `src/sdk/*-operation.ts` owns typed input/deadline/result adaptation only. Runtime membership, trust, Guest approval, and mutable registries remain injected from the source runtime.
- `src/cli/commands/*` owns Commander parsing, formatting, and exit semantics. `src/tools/*` owns Pi tool schemas and lifecycle hooks.

## Adding another operation

1. Define the smallest typed input/result/error contract in a dedicated `src/sdk/*-operation.ts` module.
2. Add separate remote and in-process dependency interfaces; do not add `execute(method, args)` or a response stub for unsupported methods.
3. Validate input, pre-aborted signals, and finite deadlines before effect IO.
4. Reuse the existing application/domain flow for in-process authority. Read membership/trust/Guest approval on every call.
5. Adapt the existing source RPC only in the remote factory; preserve lost-ack and malformed-result semantics.
6. Add shared contract tests for happy, rejection, identity, cancellation, deadline, offline, and dispatch-uncertainty paths.
7. Integrate CLI or Pi at its edge, then prove the packed SDK import, type surface, dependency graph, and in-process no-host-context path with `npm run verify:package` (also included by `npm run verify:cli`).

Intentional differences must be documented in the operation contract: for example, SDK Ask re-waits a pending Request while CLI Ask reports `timeout-after-idle`; neither path claims that acceptance means a response or completed work.
