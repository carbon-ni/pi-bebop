---
id: TASK-0025
title: Add structured per-message instructions
status: todo
depends_on: [TASK-0024]
priority: high
tags: [messaging, instructions, schema, crew]
---

# Add structured per-message instructions

## Problem
Senders can only provide one undifferentiated message string, so task-specific instructions cannot be validated, rendered, or distinguished from message content and transport metadata.

## Context

Extend `message.send` params with a structured payload:

```json
{
  "content": "Review the current patch",
  "instructions": [
    "Focus on correctness and regression risk",
    "Reply with file and line evidence"
  ],
  "mode": "steer"
}
```

`instructions` is optional and ordered. It is distinct from:

- crew member role instructions from `crew.json`, which enter the member's system context;
- callback `sender_info`, which is machine-readable transport metadata;
- message `content`, which is the sender's primary text.

Per-message instructions are untrusted sender input at user-message priority. They must never be injected into system context or represented as privileged policy. The recipient should receive a deterministic, clearly labelled rendering without ambiguous ad-hoc XML.

## Implementation approach

1. Write failing domain/schema tests for payload validation, limits, ordering, escaping, and instruction-free compatibility.
2. Add one `MessagePayload` schema/type used by JSON-RPC, direct-message service, registered tools, CLI, and server handler.
3. Add a pure recipient renderer that keeps content and sender instructions visibly distinct, round-trips arbitrary Unicode/newlines, and cannot be confused by delimiter-like user text.
4. Extend `send_to_member` and direct socket/session surfaces with optional instructions; add repeatable CLI `--instruction <text>` while preserving stdin as content only.
5. Keep role instructions in membership system context and sender metadata in its existing transport layer; test that the three channels never overwrite or masquerade as one another.
6. Document semantics, precedence, limits, examples, and the fact that receiver code must treat instructions as untrusted user content.

## Acceptance criteria

- [ ] `message.send` requires non-empty `content`, accepts an optional ordered `instructions` array, and uses the shared runtime schema from TASK-0024.
- [ ] Empty instructions, non-string values, NULs, excessive instruction count, oversized individual instructions, and oversized aggregate payloads fail with `-32602` before delivery.
- [ ] Limits are named constants, byte-based where transport size matters, deterministic, and documented.
- [ ] Messages without `instructions` retain current visible/model behavior and do not gain empty headings or wrappers.
- [ ] Messages with instructions reach the recipient with content and each ordered instruction clearly distinguishable.
- [ ] Arbitrary Unicode, multiline content, markdown, XML-like tags, JSON-looking text, and delimiter-like content cannot alter field boundaries in the rendered recipient message.
- [ ] Per-message instructions remain user-priority content and are never appended to the system prompt or member role instructions.
- [ ] Member role instructions, per-message instructions, and callback sender metadata remain independently testable and cannot overwrite one another.
- [ ] `send_to_member`, direct session/socket messaging, and `pi-bebop send` expose the same optional instruction semantics; CLI repeatable flags preserve order.
- [ ] Response/event schemas do not echo instruction text unless explicitly required, preventing unnecessary prompt leakage.
- [ ] Happy paths and validation, escaping, size-limit, metadata-integrity, and no-instruction regression paths pass, followed by coverage/risk analysis and the final watcher gate.

## Out of scope

- Treating sender instructions as trusted policy or system prompts.
- Persisting reusable instruction templates in the manifest.
- Executing instruction content as shell commands or tool calls outside the recipient agent's normal decision flow.
- Changing crew member role-instruction semantics.

