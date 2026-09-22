---
id: TASK-0221
title: Publish a typed Bebop client SDK
status: todo
depends_on: [TASK-0061]
priority: high
tags: [sdk, api, crew, typescript, security]
---

# Publish a typed Bebop client SDK

## Problem

Scripts can invoke Bebop's CLI, but cannot import one stable, typed client to query or communicate with a Crew member. Consumers would otherwise duplicate socket discovery, protocol validation, trust routing, timeouts, and error mapping. We need a small public SDK that delegates through an already-joined trusted Pi session and preserves Bebop's existing transport semantics.

## Desired outcome

A Node.js ESM/TypeScript consumer imports `@carbon-ni/pi-bebop/sdk`, creates one bounded client for a running joined source Pi session, and can:

1. fetch one member's mechanical status;
2. send one transient non-interrupting Follow-up; and
3. persist one durable Inbox message.

The SDK is a typed adapter over the existing application/protocol boundary. It does not expose raw RPC, load a manifest as authority, start Pi, infer task progress, or invent new delivery semantics.

## Proposed first API

```ts
import { createBebopClient, BebopClientError } from "@carbon-ni/pi-bebop/sdk";

const bebop = createBebopClient({ timeoutMs: 5_000 });
const sources = await bebop.listSources({ signal });
const crew = bebop.selectSource({
  session: process.env.PI_SESSION_ID ?? sources[0].session,
});

const status = await crew.getMemberStatus("Dave", { signal });
await crew.sendFollowUp("Dave", {
  message: "Build finished",
  instructions: ["Review the attached evidence"],
}, { signal });
await crew.sendToInbox("Dave", {
  message: "Durable context for your next startup",
}, { signal });
```

The selected `session` is an ID or alias for an already-running, joined Pi member. Source discovery is bounded and returns only public session metadata. Selection may explicitly fall back to `PI_SESSION_ID`; missing or ambiguous selection fails before member transport. Exact method names may change during TDD if a smaller coherent shape emerges.

## Semantics

- `getMemberStatus` returns the existing `MemberStatus` union. An offline configured member is a successful observation. Activity is mechanical (`idle`, `busy`, or `compacting`) and never verified intent, progress, or completion.
- `sendFollowUp` returns an accepted transport result only. It does not wait for or expose an assistant response.
- `sendToInbox` returns durable persistence/acceptance evidence only. It does not claim that the member read or acted on the item.
- Operational failures throw `BebopClientError` with a stable public `code`; cancellation is distinguishable. A lost acknowledgement after a messaging write reports `outcome-unknown` and is never retried automatically. Error messages and public results do not expose socket paths, capability material, request IDs, credentials, or private protocol detail.

## Trust and threat boundaries

- The caller, member label, message, instructions, session selector, environment, peer response, and local socket filesystem are untrusted inputs.
- The joined source session remains authoritative for Crew membership, exact-name/unique-role resolution, project trust, self-query policy, and target routing.
- Local control sockets are same-user filesystem capabilities, not cryptographic identity. Discovery and selection must stay within Bebop's controlled session socket namespace.
- The SDK must not accept an arbitrary source/target socket, manifest path, or bypass the source session by parsing `crew.json` itself.
- All operations validate existing payload bounds, use finite deadlines, accept `AbortSignal`, parse responses with existing protocol guards, and close transport resources on every path.
- Status is read-only. Messaging methods are explicit effects and never retry automatically after an ambiguous transport failure.

## Acceptance criteria

### Public package

- [ ] Add a dedicated `src/sdk/` composition boundary with no Pi UI/tool/Commander dependency.
- [ ] Export a minimal client constructor, public input/result types, `MemberStatus`, and one typed public error from `@carbon-ni/pi-bebop/sdk`.
- [ ] Preserve the package root/extension entry point. Add an explicit `./sdk` package export with runnable ESM JavaScript and matching `.d.ts` declarations.
- [ ] `npm pack` contains the SDK JavaScript and declarations. A clean temporary JavaScript consumer and a clean temporary TypeScript consumer can import and typecheck the packed package.

### Source-session delegation

- [ ] `listSources({ signal? })` performs bounded local discovery and returns redacted public metadata without loading Crew manifests or claiming a source is trusted/joined until queried.
- [ ] Explicit session selection takes precedence over `PI_SESSION_ID`; missing, malformed, unknown, or offline source sessions return stable distinct errors.
- [ ] Session ID and alias fallback behavior matches the existing CLI source resolution and cannot escape the controlled session socket namespace.
- [ ] The SDK delegates target resolution and authorization to the joined source session. It never reads a Crew manifest to authorize an operation.

### Status

- [ ] `getMemberStatus(nameOrUniqueRole, { signal? })` preserves the existing online/offline `MemberStatus` shape and target-provided `observedAt` unchanged.
- [ ] Unknown member, ambiguous role, self-query, malformed peer response, timeout, cancellation, and transport failure map to stable documented SDK error codes.
- [ ] Status does not start, steer, interrupt, wake, or send a model turn.

### Communication

- [ ] `sendFollowUp` reuses the existing ordinary Follow-up path and reports only transport acceptance/rejection.
- [ ] `sendToInbox` reuses the existing durable Inbox path and reports persistence/acceptance without claiming delivery or completion.
- [ ] Message and instruction validation is identical to existing tool/CLI protocol bounds. Empty, oversized, or malformed input fails before socket IO.
- [ ] No automatic retry occurs after an ambiguous write/read failure, preventing duplicate messages.

### Lifecycle and tests

- [ ] Every operation has one finite configurable end-to-end deadline with a safe default and bounded minimum/maximum; discovery, alias fallback, source RPC, target probe, and target RPC consume the same remaining budget rather than stacking full timeouts.
- [ ] Abort before resolution performs no IO; abort during transport closes the request and yields the stable cancellation error.
- [ ] Concurrent calls have isolated request IDs/state and do not leak listeners, sockets, timers, or results across calls.
- [ ] Unit tests inject source resolution and transport adapters. Integration tests use real local sockets for online, offline, malformed, timeout, and cancellation paths.
- [ ] Package-contract tests verify exports, declarations, packed contents, and both JS/TS consumer examples.
- [ ] README documents installation, status caveats, effect semantics, source-session selection, cancellation, error handling, and copy-paste scripts.

## Non-goals for v0.1

Browser/Deno support, remote network transport, process lifecycle/orchestration, raw RPC access, direct manifest-authorized calls, Guest APIs, broadcast, Redirect, interrupt, idle waiting, request/response conversations, subscriptions, automatic retries, semantic progress, or compatibility guarantees beyond the documented public SDK surface.

## Delivery slices

1. **Package walking skeleton:** `./sdk` export, declarations, packed JS/TS import tests, injected client dependencies.
2. **Read-only status:** source-session delegation and complete status/error/cancellation matrix.
3. **Explicit messaging:** Follow-up and durable Inbox with shared validation and no retry.
4. **Hardening/docs:** concurrency/leak tests, redaction, package verification, examples, and release note.

## Decisions required before implementation

1. Confirm Node.js ESM-only is acceptable for the first release.
2. Confirm the first SDK includes both messaging methods, or ship read-only status first.
3. Confirm the public error style: thrown `BebopClientError` (proposed) versus discriminated `{ ok, value/error }` results.
4. Confirm whether source discovery plus explicit selection is the default, with `PI_SESSION_ID` as an explicit convenience fallback.
