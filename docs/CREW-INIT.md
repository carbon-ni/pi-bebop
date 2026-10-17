# Set up a crew

From your project root, run:

```bash
bebop crew init
bebop crew roles
```

`crew init` creates `.pi/bebop/crew.json`, shared and role instructions, and a `sockets/` directory. It does not prompt, start members, or overwrite your files. A byte-identical rerun changes nothing; a partial or conflicting layout fails without a partial update. Use `--project <directory>` to target another project and `--format toon|json` for structured output.

## Review the scaffold

The default manifest has `lead`, `product`, `developer`, and `quality` members. It uses shared instructions at `instructions/common.md`, role instructions under `instructions/`, and `product` as the local Intake contact. Review names, roles, contact, and instructions before joining. The contact receives external Intake; it does not become a manager, permission, or default internal recipient.

Start members in separate terminals, using roles shown by `crew roles`:

```bash
pi --crew-role lead
pi --crew-role developer
```

Inside Pi, `/crew members` shows the active roster with `current`, `online`, or `offline` observations. It does not report task progress. Agent tools become available only after joining. Instructions load when a member starts, restores, or joins again; edit, leave, and rejoin to refresh them.

## Customize the manifest

You can also write `.pi/bebop/crew.json` yourself. A minimal version 1 manifest names each member, role, and project-relative socket:

```json
{
	"version": 1,
	"members": [
		{ "name": "lead", "role": "lead", "socket": "sockets/lead.sock" },
		{ "name": "developer", "role": "developer", "socket": "sockets/developer.sock" }
	]
}
```

Version 2 supports one shared `commonInstructionsFile` and per-member `instructionsFile` entries under `.pi/bebop/instructions/`:

```json
{
	"version": 2,
	"commonInstructionsFile": "instructions/common.md",
	"members": [
		{
			"name": "Bob",
			"role": "developer",
			"socket": "sockets/Bob.sock",
			"instructionsFile": "instructions/developer.md"
		}
	]
}
```

A member can have inline instructions **or** an instruction file, not both. Instruction files must stay under the active layout's `instructions/` directory; symlink escapes, blank files, invalid UTF-8, and files over 64 KiB are rejected. A short `description` helps people choose between members with the same role; it is not a routing key or permission. Address an exact name when roles repeat.

The scaffold ignores runtime sockets, private Inbox records, and Intake files in Git. To submit local text to the configured contact, follow the [Intake guide](LOCAL-INTAKE.md). For command options and diagnostics, see the [CLI guide](CLI.md) or `bebop crew init --help`.
