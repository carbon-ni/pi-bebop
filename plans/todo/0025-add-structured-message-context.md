---
id: TASK-0025
title: Add structured message context
status: todo
depends_on: [TASK-0024]
priority: high
tags: [messaging, instructions, origin, schema, crew]
---

# Add structured message context

## Problem
Senders can only provide one undifferentiated message string, so the recipient cannot reliably distinguish content, task instructions, and basic crew attribution such as “Bob (dev)” or “Kelly (qa).”

## Context

Extend `message.send` params with a structured payload:

```json
{
  "content": "Review the current patch",
  "instructions": [
    "Focus on correctness and regression risk",
    "Reply with file and line evidence"
  ],
  "origin": {
    "kind": "crew",
    "name": "Bob",
    "role": "dev"
  },
  "mode": "steer"
}
```

`instructions` is optional and ordered. Every wire `origin` is claimed/unverified attribution, not an authentication claim. Crew-aware official send surfaces populate name and role from current membership automatically; their tool schemas do not let callers retype or override joined identity. A raw socket client can still claim `{ kind: "crew", name: "Bob", role: "dev" }`, and receivers must not classify any wire origin as trusted. Direct CLI/socket callers may omit origin or provide a claimed external label.

These fields are distinct from:

- crew member role instructions from `crew.json`, which enter the member's system context;
- optional callback routing (`replyTo`), which says where a response can go;
- message `content`, which is the sender's primary text.

Attribution should be present even when callback replies are disabled. A synchronous message can therefore render `from Bob (dev)` without carrying a reply route. Per-message instructions and origin remain user-level context; they must never be injected into system context or represented as privileged policy. The recipient should receive deterministic, clearly labelled rendering without ambiguous ad-hoc XML.

## Implementation approach

1. Write failing domain/schema tests for payload validation, limits, ordering, origin variants, escaping, and instruction/origin-free compatibility.
2. Add one `MessagePayload` schema/type used by JSON-RPC, direct-message service, registered tools, CLI, and server handler.
3. Add a pure recipient renderer that keeps origin, content, and sender instructions visibly distinct, round-trips arbitrary Unicode/newlines, and cannot be confused by delimiter-like user text.
4. Make crew-aware tools derive `{ name, role }` from active membership. Keep origin independent from optional reply routing so all wait/reply modes preserve attribution.
5. Extend direct socket/session surfaces with optional instructions; add repeatable CLI `--instruction <text>` and optional `--from <label>` for explicitly claimed external attribution while preserving stdin as content only.
6. Keep role instructions in membership system context; test that role instructions, message instructions, origin, and reply routing never overwrite or masquerade as one another.
7. Test execute-time identity changes (leave/rejoin), unjoined behavior, both reply policies, direct external attribution, and raw-socket spoof claims.
8. Document semantics, display examples, limits, and the intentionally lightweight/unverified origin model.

## Acceptance criteria

- [ ] `message.send` requires non-empty `content`, accepts optional ordered `instructions` and schema-valid `origin`, and uses the shared runtime schema from TASK-0024.
- [ ] Empty instructions, non-string values, NULs, excessive instruction count, oversized individual instructions, and oversized aggregate payloads fail with `-32602` before delivery.
- [ ] Limits are named constants, byte-based where transport size matters, deterministic, and documented.
- [ ] Messages without instructions or origin retain current visible/model behavior and do not gain empty headings or wrappers.
- [ ] Messages with instructions reach the recipient with content and each ordered instruction clearly distinguishable.
- [ ] Exact recipient tests cover Bob (dev) → Kelly and Kelly (qa) → Bob, rendering `from Bob (dev)` and `from Kelly (qa)` under synchronous and asynchronous delivery.
- [ ] `send_to_member` and joined `send_to_session` derive origin at execute time from current membership—not session name, target, caller args, or stale cached identity; leave/rejoin changes attribution and unjoined behavior is explicit.
- [ ] Message origin and callback routing are independent: `end_conversation` and `allow_reply` preserve identical origin while only `replyTo` changes; synchronous/no-reply messages omit the route.
- [ ] Official tool schemas reject caller origin/name/role overrides before RPC. This is API hygiene, not receiver-side authentication.
- [ ] All received wire origins are treated as claimed/unverified. Raw-socket crew spoof input is accepted or rejected only by schema shape and never upgraded to trusted provenance.
- [ ] Direct CLI origin absent/present cases are covered; `--from` renders as claimed external attribution, not as verified crew identity.
- [ ] Renderer adversarial coverage places origin-like headings, delimiters, XML, JSON, Unicode, and newlines in content, instructions, crew name/role, and external labels without altering field boundaries.
- [ ] Per-message instructions remain user-priority content and are never appended to the system prompt or member role instructions.
- [ ] Member role instructions, per-message instructions, origin, and callback routing remain independently testable and cannot overwrite one another.
- [ ] `send_to_member`, direct session/socket messaging, and `pi-bebop send` expose compatible instruction/origin semantics; CLI repeatable instruction flags preserve order and optional `--from` is explicitly unverified.
- [ ] Discriminated origin variants reject unknown fields, empty/whitespace/NUL values, invalid types, and byte/aggregate limit violations with `-32602` before delivery.
- [ ] Response/event schemas do not echo instruction or origin text unless explicitly required, preventing unnecessary prompt leakage.
- [ ] Happy paths and validation, escaping, size-limit, metadata-integrity, and no-instruction regression paths pass, followed by coverage/risk analysis and the final watcher gate.

## Out of scope

- Cryptographic authentication, OS peer credential verification, or proof of crew identity.
- Treating sender instructions or claimed origin as trusted policy or system prompts.
- Persisting reusable instruction templates in the manifest.
- Executing instruction content as shell commands or tool calls outside the recipient agent's normal decision flow.
- Changing crew member role-instruction semantics.

