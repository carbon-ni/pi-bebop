import { Command } from "commander";
import type { CliFormat } from "../arguments.ts";

/**
 * TASK-0057: the first per-action command module (PO sequencing review:
 * every command/action lives in an isolated schema+handler module published
 * through one owned registry; shared dispatcher files are never extended
 * directly by a slice).
 *
 * Declarative Commander schema for `crew init` — the single flag definition.
 * Tokenization and deterministic help generation are the only things the
 * library owns; semantic validation, path resolution, and error mapping stay
 * in the parser facade (app-owned). The approved help bytes come from the
 * domain `crewInitHelp()` so the 0056 contract stays byte-compatible.
 */

export interface CrewInitLeafOptions {
	readonly project?: string;
	readonly format: CliFormat;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

export function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

/** Builds the declarative leaf command. Help text is supplied by the caller to keep bytes deterministic. */
export function buildCrewInitCommand(): Command {
	return new Command("init")
		.description("Scaffold a canonical .pi/bebop software crew in a project")
		.option("--project <directory>", "Target project root (default: current working directory)")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.showHelpAfterError(false);
}

/** Reads the parsed leaf values from a command that was parsed with injected argv. */
export function readCrewInitLeafOptions(parsed: Command): CrewInitLeafOptions {
	const opts = parsed.opts<{ project?: string; format?: string }>();
	return {
		...(opts.project === undefined ? {} : { project: opts.project }),
		format: (opts.format ?? "toon") as CliFormat,
	};
}
