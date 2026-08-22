---
id: TASK-0023
title: Add direct socket messaging CLI
status: todo
depends_on: []
priority: high
tags: [crew, cli, rpc, automation]
---

# Add direct socket messaging CLI

## Problem
Only Pi agents can currently use the registered messaging tools conveniently; shell users and automation with access to a live crew endpoint lack a supported command for delivering a message and optionally waiting for the response.

## Context

Expose a standalone executable for direct endpoint messaging:

```bash
pi-bebop send \
  --socket .pi/bebop/sockets/lead.sock \
  --message "Review the current changes"
```

The member endpoint is already a filesystem capability: the CLI should not require a crew manifest, active Pi membership, or project trust. Operating-system access to the Unix socket remains the authorization boundary. This intentionally sends to one endpoint, not to a role resolved from a manifest.

The first version should support:

- `--socket <path>`: required; relative paths resolve from the current directory.
- Exactly one message source: `--message <text>` or `--stdin` for multiline/private input.
- `--mode steer|follow_up`, default `steer`.
- `--wait turn_end|accepted`, default `turn_end`; `accepted` returns after RPC acknowledgement.
- `--timeout <duration>` with a finite documented default.
- `--format toon|json|text`, default `toon` for deterministic automation and `text` for direct human use.
- `--full` disables bounded assistant-response previews.

External CLI calls have no live sender session, so they must not attach `sender_info` or claim callback/reply support.

## Implementation approach

1. Write parser and renderer tests first: success, stdin, invalid/missing/unknown flags, conflicting message sources, timeout, offline socket, server rejection, and turn completion without an assistant message.
2. Extract the runtime-independent direct-message operation from the registered tool adapter so the Pi tool and CLI share RPC semantics without importing each other's presentation layer.
3. Add a thin CLI composition root that validates all arguments before filesystem or socket IO, handles signals, maps errors to stable exit codes, and renders only at the output boundary.
4. Publish a `pi-bebop` package `bin` entry whose installed artifact runs with plain Node and production dependencies only; add a deterministic build/prepack path rather than requiring global `tsx`.
5. Add an integration test against a temporary Unix socket and an installed/built CLI artifact.
6. Document shell, stdin, immediate acknowledgement, synchronous response, and output-format examples.

## Output and exit contract

- Success and expected errors use the selected format on stdout; debug/progress diagnostics alone use stderr.
- TOON and JSON include stable fields for `ok`, `target`, `status`, and response/error data.
- `text` success prints only the useful acknowledgement or assistant response.
- Exit `0`: delivered/completed successfully.
- Exit `1`: operational failure such as offline socket, timeout, abort, or remote rejection.
- Exit `2`: usage error; output names the invalid input and valid alternatives.
- Large assistant responses are bounded with explicit truncation metadata and a documented full-output option.

## Acceptance criteria

- [ ] `pi-bebop send --socket <live-member-endpoint> --message <text>` delivers a steer message without requiring a running sender Pi session.
- [ ] `--stdin` delivers exact multiline UTF-8 input; empty stdin and conflicting message sources fail before connecting.
- [ ] `--wait turn_end` waits for and returns the completed assistant message; `--wait accepted` returns after delivery acknowledgement.
- [ ] A finite timeout and SIGINT abort close the RPC connection and return exit `1` without a stack trace.
- [ ] Offline sockets, permission denial, RPC rejection, malformed response, timeout, and missing assistant response produce distinct actionable errors.
- [ ] Unknown flags and invalid enum/duration values return exit `2` before socket IO.
- [ ] Default TOON output is deterministic and specification-compatible; JSON is semantically equivalent and text remains concise.
- [ ] The CLI never adds callback sender metadata and documentation states that filesystem socket permissions are the authorization boundary.
- [ ] Both `.pi/bebop/sockets/*` and `.pi/crew/sockets/*` work because targeting is direct; no manifest fallback or role lookup is introduced.
- [ ] The existing `send_to_member` and `send_to_session` behavior remains unchanged and uses the shared direct-message operation.
- [ ] Package installation exposes `pi-bebop`; the built executable runs under plain Node without development dependencies.
- [ ] Focused parser, renderer, transport, integration, packaging, unhappy-path, and truncation tests pass, followed by the final watcher gate.

## Out of scope

- Looking up a member by name or role from the CLI.
- Broadcasting to every crew member.
- Remote TCP/network transport or authentication beyond Unix socket permissions.
- Callback chat to the external CLI process.

