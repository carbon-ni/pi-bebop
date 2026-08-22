---
id: TASK-0026
title: Add manifest-backed crew members command
status: done
depends_on: [TASK-0022]
priority: high
tags: [crew, command, ux, sockets]
---

# Add manifest-backed crew members command

## Problem
The existing `/crew list` command lists generic Bebop sessions, while users need a command that explicitly inspects the joined crew's members, roles, endpoint sockets, and availability.

## Context

Replace `/crew list` atomically with `/crew members`, backed by the manifest selected by current membership. Do not retain `list` as an alias or deprecated path. Bebop intentionally does not own generic session discovery, so the existing global-session listing should be removed rather than moved to another crew subcommand.

Expected shape:

```text
Crew: /project/.pi/bebop/crew.json
Members (3):
- lead (lead) — current — /project/.pi/bebop/sockets/lead.sock
- Bob (dev) — online — /project/.pi/bebop/sockets/Bob.sock
- Kelly (qa) — offline — /project/.pi/bebop/sockets/Kelly.sock
```

Rows follow manifest order. Show configured project member endpoints, not resolved global UUID socket destinations. Full role instructions stay out of default list output to keep it compact and avoid unnecessary disclosure.

When not joined, do not guess between project manifests or silently load configuration. Return an actionable message directing the user to `/crew join <socket>`; active membership is the source of truth for which crew to list.

## Implementation approach

1. Write failing renderer/command tests for joined, unjoined, current, online, offline, broken-link, and probe-failure paths.
2. Replace `renderSessionList` with a pure crew-row formatter plus injected endpoint availability probe.
3. Probe member endpoints concurrently with a short finite timeout, then render results deterministically in manifest order.
4. Remove generic live-session discovery and RPC status probing from `/crew members` dependencies and tests; do not add a replacement `/crew sessions` command.
5. Update command descriptions, README, architecture notes, and examples to state exact list semantics.

## Acceptance criteria

- [ ] `/crew members` while joined shows the roster directly without an `[intray-status]` or replacement bracketed custom-message header: manifest path, total member count, and one row per configured member.
- [ ] Each row includes all requested crew-member information: member name, role, absolute configured member socket path, and exactly one status: `current`, `online`, or `offline`.
- [ ] The active member is identified from membership identity, not inferred from name, role, or probe outcome.
- [ ] Non-current endpoints are probed concurrently with a finite timeout; connection errors, missing sockets, and broken/stale links render as `offline` without failing the whole list.
- [ ] Output order always matches manifest order regardless of probe completion order.
- [ ] Output shows project member endpoints only and never leaks resolved global UUID socket paths.
- [ ] Full member instruction text is not included in default list output.
- [ ] `/crew members` while unjoined performs no manifest read or global session discovery and returns `Crew not joined. Use /crew join <socket>.` without triggering an agent turn.
- [ ] Generic session IDs, branch aliases, and unrelated live Bebop sessions no longer appear in `/crew members` output.
- [ ] Both `.pi/bebop` and `.pi/crew` memberships render correctly after TASK-0022; no layout-specific formatter branches are introduced.
- [ ] Command help/completions, README, architecture documentation, and local agent guidance describe the exact direct roster output and explicitly state that `/crew members` has no `[intray-status]` wrapper and triggers no agent turn.
- [ ] Happy/unhappy command tests, endpoint probe tests, coverage/risk analysis, and the final watcher gate pass.

## Out of scope

- Loading or choosing a manifest while unjoined.
- Generic session discovery.
- Printing global transport socket destinations.
- Editing members or instructions from `/crew members`.

