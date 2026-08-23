---
id: TASK-0049
title: Make Bebop agent context strictly membership-scoped
status: doing
depends_on: []
priority: high
tags: [crew, context, tools, lifecycle, tokens, privacy]
---

# Make Bebop agent context strictly membership-scoped

## Problem
Bebop is globally useful, but independent Pi sessions should not pay for crew tool schemas or receive management-view context when they have not joined a crew. Registered membership tools currently become active by default before membership restore, and `/crew` inspection commands persist model-visible messages.

## Context

Define agent-facing lifecycle by active membership, not extension installation or base socket-server state.

### Unjoined

- Membership tools remain registered for later activation but are absent from active provider tool schemas.
- `before_agent_start` leaves system prompt byte-identical.
- Role instructions, Presence, Inbox offers, and crew announcements are not injected.
- Human `/crew` command remains available.
- `--crew` may start base server without LLM-context cost.

### Joined

- Activate exactly `send_follow_up`, `redirect_member`, `send_to_inbox`, `broadcast_to_crew`, and `interrupt_member` (the full post-0045 public surface; interrupt is a shipped public tool, not a hidden surface).
- Inject membership identity/roster/current Role instructions.
- Start existing Presence and Inbox behavior.

Existing historical messages cannot be removed when member leaves. "Zero unjoined footprint" means no active tool schemas, no system-prompt addition, and no new model-visible management messages; use new session/compaction to reclaim previous history.

## Implementation approach

1. Write failing extension-lifecycle tests proving newly registered membership tools are inactive before `session_start` and unrelated tools are preserved.
2. Reconcile active tool set deterministically: inactive on extension load/new unjoined/server-only/restore failure; active only after successful join or persisted restore; inactive after leave/stop/shutdown.
3. Keep tools registered and use `setActiveTools`; do not lazy-register or split package because Pi has no unregister API and current join activation seam already exists.
4. Write failing command/rendering tests, then move `/crew members`, `/crew status`, `/crew inbox status`, join/restore/release announcements from `sendMessage` to durable TUI-only custom entries where persistence is useful, or UI notification where it is not.
5. Keep model-visible Presence transitions and Inbox message handoff strictly joined-only; do not change their semantics.
6. Measure provider-facing active schemas and system-prompt delta for joined and unjoined fixtures.

## Acceptance criteria

- [ ] Fresh extension load leaves all five membership tools registered but inactive before first possible agent request.
- [ ] New session with no persisted membership and base-server-only `--crew` startup keep membership tools inactive.
- [ ] Unjoined `before_agent_start` returns no replacement prompt/message and changes zero bytes.
- [ ] Successful explicit join, startup socket join, and active persisted restore activate exactly five membership tools once.
- [ ] Failed join/restore, inactive resume/fork state, leave, stop, and shutdown leave/remove membership tools from active set.
- [ ] Activation/deactivation preserves order and membership of all unrelated built-in and extension tools and is idempotent.
- [ ] Joined behavior still injects current identity, manifest-order names/roles, and only current member Role instructions.
- [ ] `/crew members`, `/crew status`, `/crew inbox status`, and lifecycle announcements render for human without participating in LLM context.
- [ ] `/crew members` retains manifest path/count/order, exact current/online/offline state, configured endpoints, finite probes, unjoined text, and no agent turn.
- [ ] Presence roster/transitions remain model-visible only while membership active; no observer starts when unjoined or notifications disabled.
- [ ] Inbox handoff remains joined-only and still uses model-visible normal Follow-up; persistence entries remain context-free.
- [ ] Tests distinguish registered tools (`getAllTools`) from provider-active tools (`getActiveTools`) and prove unjoined provider tool set excludes Bebop membership schemas.
- [ ] Token evidence records zero recurring Bebop system/tool-schema delta while unjoined and bounded joined baseline before/after.
- [ ] Documentation states extension installation, server online, and joined membership are distinct; only joined membership enables agent surfaces.
- [ ] Focus/Status TASK-0046/0047 and Member Description TASK-0048 remain behaviorally unchanged and unblocked.
- [ ] Focused tests, coverage/risk analysis, and final watcher gate pass.

## Out of scope

- Removing Bebop extension, changing auto-restore policy, filtering old session history, changing message delivery semantics, Presence redesign, Inbox payload limits, Role-instruction limits, tool-description compression, or implementing TASK-0046/0047/0048.
