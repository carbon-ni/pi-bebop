---
id: TASK-0211
title: Port Current Member session naming to main
status: todo
depends_on: []
priority: high
tags: [crew, membership, session-name, lifecycle, pi-api, tdd]
---

# Port Current Member session naming to main

## Problem

TASK-0127 implemented Current Member session naming on the divergent `experiment` branch, but it never reached `main`. Consequently, `pi --crew-role <role>` joins the correct Member while the Pi session keeps a generic or prompt-derived display name.

## Desired outcome

When a Pi session becomes a joined Crew Member, Bebop gives an otherwise unnamed session the exact trusted Member name. User-owned session names always win.

## Source evidence

Use the TASK-0127 contract and commits `088f03a`, `77b5897`, `d212183`, and `8d73af9` as design evidence. Port the behavior into current composition; do not cherry-pick old composition-root files.

Pi 0.85 provides `pi.setSessionName(name)`, `pi.getSessionName()`, and `session_info_changed`. An empty name clears the display name.

## Acceptance criteria

- [ ] Successful startup with `pi --crew-role <role>` names an unnamed Pi session with the exact configured Current Member `name`, never the role, socket, description, or CLI argument.
- [ ] Successful `--crew-socket`, `/crew join`, persisted restore, and rejoin apply the same rule.
- [ ] An existing name from `--name`, `/name`, RPC, or another extension is preserved byte-for-byte.
- [ ] A manual name change after Bebop auto-naming relinquishes ownership immediately and is never overwritten or cleared by later Membership activity.
- [ ] While Bebop owns the name, switching Current Member updates it; a role-only refresh with the same Member name is idempotent.
- [ ] Leave, inactive Membership, failed restore, session replacement, and shutdown clear the name only when it is still Bebop-owned and unchanged.
- [ ] Reload, resume, and fork reconstruct ownership only from a bounded typed custom session entry matching current name and Membership; equal text alone never grants ownership.
- [ ] Auto-owned Member names are display metadata only and are excluded from unscoped runtime alias publication; collision-safe project/branch aliases remain.
- [ ] Manual safe session names retain existing alias behavior.
- [ ] Naming performs no model/provider turn, message injection, network IO, or identity/authority inference.
- [ ] Failures from stale Pi contexts or name APIs are bounded and do not break Membership activation or cleanup.
- [ ] Deterministic tests cover unnamed/named startup, restore, rejoin, Member switch, manual override/clear, leave/shutdown, failed restore, reload/resume/fork, duplicate names across projects, alias behavior, and no-turn behavior.
- [ ] README documents the behavior and manual override rule.
- [ ] Focused tests, CLI verification, and final quality gate pass.

## Constraints

- Keep reusable ownership decisions pure and separate from Pi lifecycle adaptation.
- Wire naming through current Membership activation/release composition rather than duplicating join logic.
- Treat session display name as convenience metadata, never Membership proof.

## Non-goals

Renaming unjoined sessions, overwriting explicit names, changing Member names, global alias redesign, naming standalone CLI processes, or changing Pi's native session picker.
