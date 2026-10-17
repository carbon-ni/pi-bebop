# Pi Bebop

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

## Development

```bash
npm install
npm run build
npm test
```

`make all` runs the pre-push gate. `make package-verify` checks the packed release with pinned consumer dependencies and may need network access.
