# CLI guide

Install globally with `npm install -g @carbon-ni/pi-bebop`, or run `npx @carbon-ni/pi-bebop --help`. Run `bebop --help` to discover commands and `bebop <command> --help` for examples and prerequisites.

## Common tasks

```bash
bebop crew init
bebop crew roles
bebop doctor
bebop member last-message developer --session "$PI_SESSION_ID" --format json
bebop session resume --role developer
```

`crew init` creates the manifest and instructions without prompting or overwriting files. An exact rerun changes nothing; a partial or conflicting layout returns an error. `crew roles` lists configured roles; it does not start members. See [crew setup](CREW-INIT.md).

`doctor` performs a bounded, read-only compatibility check of the installed CLI, trusted crew, and discoverable member runtimes. It does not send messages, start model turns, or mutate state. Package version and build commit identify the installed artifact; runtime protocol and capabilities identify supported actions. SemVer alone does not prove compatibility. Default output hides sessions, sockets, endpoints, raw protocol methods, capabilities, and credentials; use `--diagnostic` only when safe protocol evidence is needed. The per-member timeout defaults to 2 seconds and accepts 1–30 seconds.

`member last-message` reads the latest recorded assistant text on the active branch, without waking the member. It never reads history or exposes user, system, reasoning, or tool content. An online member without assistant text returns `message: null`; an offline member returns `offline-member`.

## Delivery and output

Use `bebop ask <crew[/member]> <question>` to send one correlated Request and wait for its Response. For manual control, use `bebop member request send` followed by `bebop member request wait`. Follow-ups, redirects, inbox sends, and broadcasts confirm delivery or persistence, **not** completed work. See [communication](COMMUNICATION.md).

Results default to plain text. Select `--format toon` for structured agent output or `--format json` for interoperability; output format does not change automatically with result size. `--help` and `-h` show command help.

To resume one previously attributed session, use `bebop session resume --role <role>`; to bookmark exact member sessions together, use `bebop session capture <name>`. See [role resume](ROLE-SESSION-RESUME.md) and [Crew Sessions](CREW-SESSION.md). Neither operation starts a whole crew.
