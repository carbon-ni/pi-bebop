---
id: TASK-0023
title: Add direct socket messaging CLI
status: doing
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

The member endpoint is already a local capability: the CLI should not require a crew manifest, active Pi membership, or project trust. A caller who can successfully connect to the Unix socket can send protocol commands; there is currently no application-level authentication. The implementation must verify and document directory/socket permission behavior on supported operating systems rather than assuming path knowledge alone grants access. This intentionally sends to one endpoint, not to a role resolved from a manifest.

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
5. Add an explicit package file allowlist so release archives exclude `.pi`, `.tmp`, plans, editor fixtures, databases, and other repository-local state.
6. Add an integration test against a temporary Unix socket and an installed/built CLI artifact.
7. Verify Unix socket/directory access behavior on supported platforms and document that connect permission—not path secrecy—is the boundary.
8. Document shell, stdin, immediate acknowledgement, synchronous response, and output-format examples.

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
- [ ] A finite timeout and SIGINT abort close pending stdin reads and RPC connections, returning exit `1` without a stack trace; subprocess coverage holds stdin open, sends SIGINT, and proves timely cleanup.
- [ ] Offline sockets, permission denial, RPC rejection, timeout, and missing assistant response produce distinct actionable errors. Malformed peer responses are explicitly deferred to TASK-0024 and must not be claimed as complete here.
- [ ] Unknown flags and invalid enum/duration values return exit `2` before socket IO in the selected output format and through the injected output stream—never implicit global stdout.
- [ ] Default TOON output is deterministic and specification-compatible; JSON is semantically equivalent and text remains concise.
- [ ] The CLI never adds callback sender metadata; tests and documentation accurately define who can connect based on directory/socket permissions on supported platforms.
- [ ] Both `.pi/bebop/sockets/*` and `.pi/crew/sockets/*` work because targeting is direct; no manifest fallback or role lookup is introduced.
- [ ] The existing `send_to_member` and `send_to_session` behavior remains unchanged and uses the shared direct-message operation, including a non-error `Turn completed but no assistant message found` result for tool adapters.
- [ ] Package installation exposes `pi-bebop`; an npm-pack/install subprocess test executes the installed `dist/cli/main.js` under plain Node without development dependencies while the Pi extension entrypoint remains loadable.
- [ ] `npm pack --dry-run` contains only intentional runtime, type, license, and documentation files—no `.pi`, `.tmp`, database, log, plan, or nested fixture state.
- [ ] Integration coverage includes accepted wait, remote rejection, timeout, SIGINT during stdin, exact multiline/empty stdin, both endpoint layouts, no outbound sender metadata, and real supported-platform permission behavior where deterministic.
- [ ] Focused parser, renderer, transport, integration, packaging, unhappy-path, and truncation tests pass, followed by the final watcher gate.

## Out of scope

- Looking up a member by name or role from the CLI.
- Broadcasting to every crew member.
- Remote TCP/network transport or authentication beyond Unix socket permissions.
- Callback chat to the external CLI process.

