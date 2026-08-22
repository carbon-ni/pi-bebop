---
id: TASK-0022
title: Support crew and Bebop project layouts
status: done
depends_on: []
priority: high
tags: [crew, compatibility, security]
---

# Support crew and Bebop project layouts

## Problem
The Bebop namespace migration changed the trusted crew manifest from .pi/crew to .pi/bebop, so existing valid crew setups now fail at startup with a generic manifest-load error.

## Context

Keep `.pi/bebop` as the canonical layout while accepting `.pi/crew` as an explicit compatibility layout. Trust must remain allowlist-based: deriving a manifest from a socket path must not make arbitrary `.pi/*/crew.json` files readable.

The selected socket determines its manifest directly:

- `.pi/bebop/sockets/lead.sock` → `.pi/bebop/crew.json`
- `.pi/crew/sockets/lead.sock` → `.pi/crew/crew.json`

There is no fallback between layouts and no ambiguity when both manifests exist. Startup, runtime join, and persisted membership restoration should share the same trusted-path policy.

## Implementation approach

1. Write failing store tests for both allowed manifest paths and an arbitrary rejected sibling path.
2. Replace the single trusted manifest path comparison with an explicit project-local allowlist while retaining `.pi/bebop/crew.json` as the default path.
3. Add lifecycle coverage proving both `--crew-socket` startup selection and `/crew join` resolve members in either layout; cover invalid/untrusted paths.
4. Improve the surfaced join error so rejected paths identify the trust/path reason instead of only reporting `failed to load crew manifest`.
5. Document `.pi/bebop` as canonical and `.pi/crew` as supported compatibility layout, including behavior when both exist.

## Acceptance criteria

- [ ] TDD tests cover successful manifest reads from exact normalized `.pi/bebop/crew.json` and `.pi/crew/crew.json` paths.
- [ ] Tests reject manifests outside those two exact project-local paths, including another `.pi/<name>/crew.json` sibling.
- [ ] `pi --crew-socket <project>/.pi/bebop/sockets/<member>.sock` joins the matching member.
- [ ] `pi --crew-socket <project>/.pi/crew/sockets/<member>.sock` joins the matching member.
- [ ] `/crew join` and membership restoration use the same two-layout policy as startup.
- [ ] When both layouts exist, the socket path deterministically selects the manifest in the same layout; no fallback or merge occurs.
- [ ] Missing, malformed, member-mismatch, and untrusted-path failures remain distinct and expose an actionable cause to the user.
- [ ] Existing endpoint ownership protections still reject live foreign links and reclaim only stale links in both layouts.
- [ ] README and architecture docs describe `.pi/bebop` as canonical and `.pi/crew` as supported compatibility layout.
- [ ] Local focused tests and the final watcher gate pass.

## Out of scope

- Supporting `.pi/intray` or arbitrary custom manifest roots.
- Merging members from two manifests.
- Automatically moving or rewriting user configuration.

