# Pi Bebop

<img width="180" alt="Pi Bebop logo" src="https://github.com/user-attachments/assets/ff4eccd9-73e7-4e09-a617-ce7b7db7e299" />

Pi Bebop connects independent [Pi](https://github.com/badlogic/pi-mono) sessions as a crew. Each member keeps its own conversation, context, and tools. Bebop delivers messages and tracks membership; your crew decides who does the work and when it is done.

## Install

Install the Pi extension:

```bash
pi install npm:@carbon-ni/pi-bebop
```

Or install it from GitHub with `pi install git:github.com/carbon-ni/pi-bebop`.

For the standalone CLI:

```bash
npm install -g @carbon-ni/pi-bebop
```

You can also run the CLI without installing it globally: `npx @carbon-ni/pi-bebop --help`. Node.js consumers can use the [SDK](docs/SDK.md).

## Start a crew

In your project:

```bash
bebop crew init
bebop crew roles
```

Review `.pi/bebop/crew.json` and the generated instructions before joining. In separate terminals, start members with roles from `crew roles`:

```bash
pi --crew-role lead
pi --crew-role developer
```

Inside Pi, run `/crew members` to see who joined. Agent tools are available only to joined members. See [crew setup](docs/CREW-INIT.md) to customize the manifest, instructions, and roles.

## Communicate

- Need an answer? Use `send_member_request`, then wait with its `request_id`, or run `bebop ask <crew[/member]> <question>` from the CLI.
- Sharing information? Use `send_follow_up`. For a member who may be offline, use `send_to_inbox`.
- Need to change or stop ongoing work? Use `redirect_member` or `interrupt_member`.

**Delivery is not completion.** A delivered message does not prove it was read or acted on; an answer does not prove it is correct. See the [communication guide](docs/COMMUNICATION.md) for tool choices and wait behavior.

## Guides

- [CLI commands, diagnostics, and output formats](docs/CLI.md)
- [Node.js SDK and delivery safety](docs/SDK.md)
- [Local Intake dropbox](docs/LOCAL-INTAKE.md)
- [Resume a session by role](docs/ROLE-SESSION-RESUME.md)
- [Bookmark member sessions together](docs/CREW-SESSION.md)

## Codemode

On Pi 1.1, nonblocking Bebop tools return structured, allowlisted results to scripts. Independent calls can run with `Promise.all` or `Promise.allSettled`. Pi 0.84 remains supported for direct tool calls.

`wait_for_member_idle`, `wait_for_request_outcome`, and `interrupt_member` are direct-only tools. They remain model-declared in codemode's `only` mode. Call blocking waits alone: nested codemode calls cannot preserve their turn-termination behavior.

A fulfilled script call can contain a semantic failure: check `error`, and for broadcasts check `summary.failed`. Invalid arguments and host failures reject. Script cancellation does not roll back accepted deliveries. Keep the returned `requestId` and use `wait_for_request_outcome` directly; do not resend an accepted request because its script ended.

## Development

```bash
npm install
npm run build
npm test
```

Codemode host acceptance is opt-in because it launches a real Pi 1.1 AgentSession. Run it with Pi 1.1 on `PATH`:

```bash
PI_BEBOP_REAL_HOST_TEST=1 node --import tsx --test src/pi/codemode-host.integration.test.ts
```

The test uses a deterministic faux provider and in-process Bebop operations; it does not contact live crew members. Codemode exposes only projected, closed DTOs, keeps blocking waits out of nested scripts, runs independent nested calls concurrently, and cancels pending children when the script exits. The test covers both `codemode.mode=on` and `codemode.mode=only`, semantic tool errors, correlated request Responses after script completion, and cancellation.

To use the CLI from this checkout:

```bash
npm link
bebop --help
```

Or install a packed release into a project:

```bash
npm install ./carbon-ni-pi-bebop-0.2.0.tgz
npx bebop --help
```

`make all` runs the pre-push gate: format, package, lint, build, test, and security checks.
Release verification is separate because it installs pinned consumer dependencies and may need network access:

```bash
make package-verify
```
