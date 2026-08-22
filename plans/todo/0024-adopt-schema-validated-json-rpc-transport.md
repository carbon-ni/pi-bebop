---
id: TASK-0024
title: Adopt schema-validated JSON-RPC transport
status: todo
depends_on: [TASK-0023]
priority: high
tags: [protocol, json-rpc, validation, security]
---

# Adopt schema-validated JSON-RPC transport

## Problem
Bebop's newline-delimited protocol currently casts loosely parsed objects to command types, so malformed methods, parameters, responses, and events can cross the socket boundary and fail late or ambiguously; the new CLI also needs a stable interoperable wire contract.

## Context

Adopt JSON-RPC 2.0 over the existing newline-delimited Unix socket framing. Each line remains one complete JSON value; only the envelope and validation change. “JRPC” here means standards-compatible JSON-RPC 2.0, not a second transport library or TCP service.

Use explicit methods:

| Method | Purpose |
|---|---|
| `session.status` | Read runtime status |
| `message.send` | Deliver one message |
| `session.get_message` | Read latest assistant message |
| `session.clear` | Rewind session |
| `session.abort` | Abort active turn |
| `event.subscribe` | Create one-shot event subscription |
| `session.turn_end` | Server notification for subscribed completion |

Requests and responses use correlated IDs. `session.turn_end` is a JSON-RPC notification carrying the subscription ID. Batch requests and client request-notifications are out of scope.

Schemas are the source of truth: derive TypeScript types from maintained runtime schemas rather than keeping handwritten interfaces and validators that can drift. Keep domain method data independent from wire envelopes.

## Implementation approach

1. Write protocol contract tests first for every request, result, error, and event schema, including malformed and adversarial input.
2. Define strict JSON-RPC 2.0 envelope schemas plus method-specific params/results using the project's maintained schema library; export machine-readable JSON Schema where practical.
3. Replace `parseCommand` casting with parse → envelope validation → method lookup → params validation. Validation must occur before any Pi/session side effect.
4. Map failures to standard JSON-RPC codes: parse error `-32700`, invalid request `-32600`, method not found `-32601`, invalid params `-32602`, internal error `-32603`; use the reserved server range for stable operational errors and safe `data.code` details.
5. Update server dispatch, client correlation, subscription handling, tools, startup paths, CLI, and integration tests atomically. Do not maintain a parallel legacy envelope.
6. Validate server responses and notifications in the client; malformed peer output must fail immediately instead of being ignored until timeout.
7. Document framing, methods, schemas, limits, error codes, correlation, and compatibility break.

## Acceptance criteria

- [ ] Every inbound request is valid JSON-RPC 2.0 with a supported method, correctly typed ID, and schema-valid params before handler execution.
- [ ] Every response echoes the request ID and contains exactly one of `result` or `error`; clients reject mismatched IDs.
- [ ] All method params and results have exported runtime schemas and derived TypeScript types with no handwritten duplicate shape.
- [ ] Unknown methods, unknown/extra params, missing required fields, wrong types, invalid enums, nulls, oversized values, malformed JSON, and invalid envelopes return deterministic standard errors without side effects.
- [ ] One-shot `event.subscribe` returns a subscription ID and emits one schema-valid `session.turn_end` notification correlated to that subscription.
- [ ] Concurrent send/subscription requests cannot consume each other's responses or events.
- [ ] Client validation reports malformed responses/notifications immediately and never leaks stack traces or raw dependency errors.
- [ ] Existing status, send, get-message, clear, abort, timeout, abort-signal, and turn-end behavior remains covered through the new protocol.
- [ ] The CLI and registered tools use the same generated protocol types and client; no adapter constructs raw JSON-RPC envelopes independently.
- [ ] Migration is atomic: production code accepts only the JSON-RPC contract, with the breaking wire change documented.
- [ ] Unix socket framing and access policy remain unchanged; JSON-RPC does not claim to add authentication.
- [ ] Focused schema, parser, server, client, concurrency, and integration tests pass, followed by coverage/risk analysis and the final watcher gate.

## Out of scope

- JSON-RPC batch requests.
- Network transport or authentication.
- Backward-compatible support for the legacy `{ type, ... }` envelope.
- Message instruction semantics, which are introduced by TASK-0025 after this transport foundation.

