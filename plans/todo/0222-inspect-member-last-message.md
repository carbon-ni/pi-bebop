---
id: TASK-0222
title: Inspect a Crew member's last assistant message
status: doing
depends_on: [TASK-0221]
priority: high
tags: [cli, sdk, status, crew, privacy]
---

# Inspect a Crew member's last assistant message

## Problem

Automation can inspect a member's mechanical status, but cannot read the member's latest assistant text without sending or waking it. Operators need one bounded, read-only observation for coordination. Direct target socket access would bypass Crew membership, trust, and target-resolution rules.

## Desired outcome

A caller can query an online Crew member's latest finalized assistant text through the CLI or typed SDK. The joined trusted source session authorizes and resolves the target. The observation never starts, wakes, steers, interrupts, or sends a model turn.

## Public shape

```bash
bebop member last-message Dave
bebop member last-message developer --format json --session <id-or-alias>
```

```ts
const observation = await crew.getMemberLastMessage("Dave", { signal, timeoutMs: 5_000 });
```

The result contains the resolved public member identity and either the existing extracted assistant message (`role`, `content`, `timestamp`) or `message: null` when the online session has no assistant text.

## Semantics and boundaries

- "Last message" means the newest assistant text on the target session's current active branch. It excludes user messages, system prompts, reasoning, tool arguments/results, socket paths, and session internals.
- The read is a snapshot, not proof of progress, completion, intent, or acknowledgement.
- An offline target cannot expose its in-memory branch and returns a stable `offline-member` error. No historical session-file scan occurs.
- The existing joined trusted source remains authoritative for exact-name/unique-role resolution, self-query policy, Crew membership, and target routing.
- The target's existing read-only message RPC may be reused after source authorization. The public CLI/SDK never accepts a target socket or manifest path.
- Empty history is a successful `message: null` result. Malformed target output is an error, never silently coerced.

## Acceptance criteria

### Domain and delegated protocol

- [ ] Define one strict, bounded public observation/result schema using the existing extracted assistant-message shape and redacted member identity.
- [ ] Add a source-delegated member-last-message command. It rejects unjoined/untrusted sources before target IO and delegates target resolution to the existing Crew resolver.
- [ ] Querying a target is read-only and performs no Pi prompt/send/steer/interrupt/wake action.
- [ ] Return only latest assistant text from current branch, unchanged, or `null` when absent. Never return user/system/tool/reasoning content.
- [ ] Offline member, unknown member, ambiguous role, self-query, malformed response, timeout, cancellation, and transport failure have stable codes.

### CLI

- [ ] Add `bebop member last-message <member-name-or-unique-role>` with `--session` and `--format text|toon|json`, consistent with `member status`.
- [ ] Text output is concise and distinguishes an empty history from an error. Structured output preserves identity, content, and timestamp.
- [ ] Help states that the command is a read-only snapshot and never wakes the member.

### SDK

- [ ] Add typed `getMemberLastMessage(member, options?)` to `BebopSource` without changing the package root or existing SDK methods.
- [ ] Reuse the SDK's one end-to-end deadline, cancellation, source selection, response validation, and stable `BebopClientError` mapping.
- [ ] Packed JavaScript and declarations expose the new method and result types to clean JS/TypeScript consumers.

### Tests and documentation

- [ ] TDD covers latest assistant text, empty history, exclusion of non-assistant/internal content, offline/error mapping, no-wake behavior, malformed peers, timeout, cancellation, and concurrent isolation.
- [ ] Real local-socket integration covers CLI and SDK delegation through a source into a target session.
- [ ] README includes concise CLI and SDK examples plus snapshot/privacy caveats.
- [ ] Full verification and independent QA pass without modifying user Crew files.

## Non-goals

Message history, user prompts, reasoning/tool inspection, offline transcript parsing, subscriptions, progress inference, remote-network transport, arbitrary session inspection, or a new agent tool.
