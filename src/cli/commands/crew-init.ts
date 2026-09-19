import { Command } from "commander";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";

/**
 * TASK-0209: `crew init` command module. The Commander builder is the sole
 * source of grammar, description, defaults, and generated help; long
 * guidance lives in after-help text. The reader owns semantic validation
 * only. No parser facade, no parallel help prose.
 */

export interface CrewInitLeafOptions {
	readonly project?: string;
	readonly format: CliFormat;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

export function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

/** Builds the declarative leaf command: grammar, defaults, and generated help. */
export function buildCrewInitCommand(): Command {
	return new Command("init")
		.description("Scaffold a canonical .pi/bebop software crew in a project")
		.option("--project <directory>", "Target project root (default: current working directory)")
		.option(
			"--format <format>",
			"Output format: text (default), toon, or json",
			defaultFormatForCommand("crew-init"),
		)
		.addHelpText(
			"after",
			[
				"",
				"Non-interactive and idempotent: never overwrites existing content and never requires --force.",
				"",
				"Files created (deterministic, versioned):",
				"  .pi/bebop/crew.json",
				"  .pi/bebop/.gitignore",
				"  .pi/bebop/instructions/{common,lead,product,developer,quality}.md",
				"  .pi/bebop/sockets/",
				"",
				"Exit codes:",
				"  0  created or byte-identical no-op",
				"  1  filesystem/conflict/operational failure",
				"  2  usage error",
				"",
				"Examples:",
				"  pi-bebop crew init",
				"  pi-bebop crew init --project /path/to/project",
				"  pi-bebop crew init --format json",
				"",
				"Review crew.json contact/names/common and role instructions before starting member processes.",
			].join("\n"),
		);
}

/** Reads the parsed leaf values and applies semantic validation only. */
export function readCrewInitCommand(parsed: Command): CrewInitLeafOptions {
	const opts = parsed.opts<{ project?: string; format?: string }>();
	const format = (opts.format ?? defaultFormatForCommand("crew-init")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return {
		...(opts.project === undefined ? {} : { project: opts.project }),
		format,
	};
}
