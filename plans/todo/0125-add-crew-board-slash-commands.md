---
id: TASK-0125
title: Add Crew Board slash commands
status: todo
depends_on: [TASK-0124]
priority: high
tags: [crew, board, command, tui, application, membership, tdd]
---

# Add Crew Board slash commands

## Problem

Human operators need to leave and inspect the same Crew Posts from the TUI without invoking an agent turn, delivering a message, or creating a separate board implementation.

## Command grammar

```text
/crew post [--kind <kind>] [--ref <safe-reference>]... [--supersedes <post-id> | --disputes <post-id>] <message>
/crew board [--kind <kind>]... [--after <cursor>] [--limit <count>]
```

Omitted post kind is `note`. Flags are explicit so ordinary prose beginning with `tip`, `feedback`, or another kind is never reinterpreted as metadata.

## Implementation plan

1. Write parser/handler tests for omitted and explicit flags, quoting/spacing, repeated filters/references, invalid combinations, and bounded errors.
2. Add `/crew post` and `/crew board` adapters to the existing `/crew` command family.
3. Delegate to TASK-0124 application operations; command code owns only parsing and bounded TUI rendering.
4. Ensure command lifecycle is observational/synchronous from the human perspective and never calls Pi message/provider APIs.

## Acceptance criteria

- [ ] `/crew post <message>` appends one `note`; explicit kind/reference/link flags produce the same canonical operation as agent tools.
- [ ] `/crew board` renders bounded latest posts in stable order; filter/cursor/limit flags match agent read semantics and show continuation guidance when truncated.
- [ ] Empty message, unknown/duplicate flag, missing value, conflicting link flags, invalid kind/reference/cursor/limit, extra positional ambiguity, and oversized input reject before Board IO.
- [ ] Parser preserves exact intended Unicode/spaces after deterministic normalization and never infers kind, target, sentiment, or priority from prose.
- [ ] Commands require Current Membership and use the same Membership-only access rule; there are no Role/owner/moderator/private-board paths.
- [ ] Commands call the shared application operations rather than store APIs directly or duplicate domain validation.
- [ ] Append/read render as TUI-only output and trigger zero `sendMessage`, `sendUserMessage`, provider call, model turn, Inbox/Broadcast/Request, or per-Member read state.
- [ ] Results never claim delivery, readership, agreement, truth, rating, authority, or task/Agreement change.
- [ ] Reload, leave, stop, shutdown, stale context, abort, concurrent append, corruption, and store failure are bounded and leak-free.
- [ ] Existing `/crew join|leave|members|status|inbox|stop` parsing/rendering remains byte-compatible outside deliberate shared help additions.

## Non-goals

Standalone `pi-bebop` CLI parity, interactive editor, automatic refresh, notifications, direct replies/threads, deletion/moderation, or ratings.
