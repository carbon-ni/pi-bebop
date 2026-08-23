---
id: TASK-0047
title: Implement member status query and focus publishing
status: done
depends_on: [TASK-0046]
priority: high
tags: [crew, status, tools, protocol, privacy]
---

# Implement member status query and focus publishing

## Problem
Joined members need compact tools to publish a bounded crew-visible focus note and query another configured member's live reachability, Pi activity, pending-message signal, and self-reported focus without triggering an agent turn.

## Context

Add strict read-only `member.status` JSON-RPC method and two compact joined-member tools:

```text
get_member_status({ member: "Bob" })
update_member_focus({ action: "set", focus: "Implementing Inbox enqueue" })
update_member_focus({ action: "clear" })
```

`get_member_status` resolves target by configured name/unique role. Transport failure for configured endpoint becomes offline result; malformed online peer output remains protocol error. `update_member_focus` mutates only current member local session state and performs no RPC.

## Acceptance criteria

- [x] Runtime schema defines strict `member.status` request/result with no caller-selected fields and no message-content data.
- [x] Target handler computes activity and pending state at request time, snapshots current focus, responds without triggering turn, and has bounded timeout.
- [x] `get_member_status` is active only while joined and accepts exactly member name/unique role.
- [x] Configured offline target returns compact offline result; unknown, ambiguous, self, untrusted/unjoined, timeout, malformed response, and abort are deterministic and tested.
- [x] `update_member_focus` uses strict `set|clear` action, requires nonblank bounded focus only for set, persists typed focus entry, and scopes restoration to current canonical member identity.
- [x] Focus renderer/tool output never exposes hidden session data and clearly labels note as member-reported.
- [x] Membership leave/switch clears active focus in memory; restoring same active membership rehydrates latest matching focus/clear entry.
- [x] Parallel query/update returns one valid snapshot; no partial focus state.
- [x] Tool descriptions teach that activity is mechanical and focus is self-reported, not verified task progress.
- [x] `/crew members` remains reachability roster and does not grow activity/focus columns; detailed status stays on-demand.
- [x] Presence observer does not poll member.status and status query does not emit presence activity.
- [x] Protocol, runtime, persistence, privacy, tool, renderer, reload/switch, and real-host idle/busy tests pass.
- [x] README/architecture/UL/role instructions document honest semantics; coverage/risk analysis and final watcher gate pass.

## Out of scope

- External queries, bulk/all-member status, background polling, monitoring alerts, task completion, session transcript access, or automatic focus updates.

