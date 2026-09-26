import { Command } from "commander";
import { discoverCrewDirectory, type CrewDirectoryDependencies } from "../../application/crew-directory.ts";
import { defaultCrewDirectoryDependencies } from "../../infra/crew-directory.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";

const MAX_OUTPUT_CREWS = 100;

export type {
	CrewDirectoryEntry,
	CrewDirectoryLiveRuntime,
	CrewDirectoryObservation,
} from "../../application/crew-directory.ts";

export interface CrewListCliOptions {
	readonly command: "crew-list";
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

/** Compatibility seam for CLI tests and callers while discovery lives in the application layer. */
export type CrewListDependencies = Omit<CrewDirectoryDependencies, "discoverManifestPaths"> & {
	readonly discoverManifestPaths?: CrewDirectoryDependencies["discoverManifestPaths"];
};

export const defaultCrewListDependencies: CrewListDependencies = defaultCrewDirectoryDependencies;

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export function buildCrewListCommand(): Command {
	return new Command("list")
		.description("List locally known Crews by public identity")
		.option(
			"--format <format>",
			"Output format: text (default), toon, or json",
			defaultFormatForCommand("crew-list"),
		)
		.option("--full", "Full response without response truncation")
		.addHelpText(
			"after",
			[
				"List trusted locally known Crews by stable selector, display name,",
				"availability, configured Member count, and freshness. Display names are",
				"informative only; use the exact Crew selector for routing.",
				"",
				"Discovery is bounded to .pi/bebop/crew.json and the .pi/crew/crew.json",
				"compatibility layout in the current project. It never scans arbitrary",
				"projects or exposes session IDs, sockets, endpoints, capabilities, or",
				"Request IDs. Duplicate selectors show only the Locator recovery values.",
				"",
				"Examples:",
				"  bebop crew list --format text",
				"  bebop crew list --format json --full",
			].join("\n"),
		);
}

export function readCrewListCommand(parsed: Command): CrewListCliOptions {
	const options = parsed.opts<{ format?: string; full?: boolean }>();
	const format = (options.format ?? defaultFormatForCommand("crew-list")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "crew-list", format, full: options.full === true };
}

function toCliOutcome(
	options: CrewListCliOptions,
	result: Awaited<ReturnType<typeof discoverCrewDirectory>>,
): CliOutcome {
	const crews = options.full ? [...result.entries] : result.entries.slice(0, MAX_OUTPUT_CREWS);
	const omitted = Math.max(0, result.entries.length - crews.length);
	const partial = result.partial || omitted > 0;
	const data = {
		crews,
		total: result.entries.length,
		omitted,
		partial,
		...(result.discovery === undefined ? {} : { discovery: result.discovery }),
		...(result.invalidCandidates === undefined ? {} : { invalidCandidates: result.invalidCandidates }),
		...(crews.length === 0 ? { next: "initialize or join a trusted Crew, then rerun bebop crew list" } : {}),
	};
	return {
		kind: "result",
		result: {
			ok: true,
			target: "",
			status:
				result.discovery === undefined || (result.discovery === "cancelled" && crews.length === 0)
					? crews.length === 0
						? "empty"
						: "listed"
					: "partial",
			data,
		},
		format: options.format,
		full: options.full,
	};
}

async function executeCrewListCommand(
	options: CrewListCliOptions,
	context: CliContext,
	deps: CrewDirectoryDependencies,
): Promise<CliOutcome> {
	const result = await discoverCrewDirectory({ projectRoot: context.cwd, signal: context.signal }, deps);
	return toCliOutcome(options, result);
}

export async function runCrewListCommand(
	options: CrewListCliOptions,
	context: CliContext,
	deps: Partial<CrewListDependencies> = {},
): Promise<CliOutcome> {
	const resolvedDependencies = {
		...defaultCrewDirectoryDependencies,
		...deps,
	} as CrewDirectoryDependencies;
	return executeCrewListCommand(options, context, resolvedDependencies);
}
