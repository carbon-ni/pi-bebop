---
id: TASK-0083
title: Enable optional values for Pi extension flags
status: todo
depends_on: [TASK-0086]
priority: high
tags: [pi-api, extensions, cli, flags, upstream, tdd]
---

# Enable optional values for Pi extension flags

## Problem
Pi rejects bare string extension flags before extensions start, so extensions cannot distinguish an omitted flag from a present flag that should trigger interactive value selection.

## Context

This is an upstream Pi capability required by Bebop. Today extension flags can
only declare `type: "boolean" | "string"`; `applyExtensionFlagValues` rejects a
bare string flag with `Extension flag "--<name>" requires a value` before
`session_start`. Add an explicit optional-value declaration while keeping
required string flags as the default.

The public contract must distinguish three states without inspecting
`process.argv`: absent, present without a value, and present with a string value.
Choose and document one stable sentinel for the bare state; do not leak the
argument parser's incidental internal representation into extensions.

## Acceptance criteria

- [ ] Tests are written first at argument parsing, extension flag application, SDK service, help, and extension integration boundaries.
- [ ] `registerFlag` supports an explicit optional-value string declaration; existing boolean and required-string declarations remain source- and behavior-compatible.
- [ ] `getFlag` deterministically distinguishes absent, bare, and valued optional flags through a documented typed contract.
- [ ] `--example=value` and `--example value` preserve the supplied string; a final bare `--example` produces the documented bare state.
- [ ] A bare optional flag before another recognized flag does not consume that flag as its value.
- [ ] Required string flags still fail before session creation when bare; unknown flags and existing diagnostics remain unchanged.
- [ ] Help identifies optional values without implying a required argument.
- [ ] TUI, print, JSON, RPC, and SDK-created session services apply the same flag semantics.
- [ ] Pi extension documentation includes the declaration and all three read states.
- [ ] Bebop updates to a Pi package version containing this capability before TASK-0084 starts.

## Out of scope

- Interactive prompting in Pi core, changing positional prompt parsing, short
  options, repeatable flags, or making every string flag optional.

## Verification

- Run focused Pi CLI/parser, resource-loader, agent-session-services, SDK, help,
  and extension tests in the upstream repository.
- Inspect public type/API change impact and verify existing extensions compile
  without modification.

## Notes

Evidence: installed Pi 0.84.2 rejects the bare flag in
`dist/core/agent-session-services.js` before Bebop receives `session_start`.

