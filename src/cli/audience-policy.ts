import { UsageError, type CliFormat } from "./support/arguments.ts";

/**
 * Single executable audience/default policy from docs/CLI-CONTRACT.md.
 * Every command's default format is declared here — leaf parsers, readers,
 * facades, and handlers must not carry their own literal fallback.
 */
const HUMAN_FIRST_COMMANDS = new Set(["crew-init"]);

/** Declared per-command default: human-first commands default to text, the rest to TOON. */
export function defaultFormatForCommand(command: string): CliFormat {
	return HUMAN_FIRST_COMMANDS.has(command) ? "text" : "toon";
}

/** argv-based command default (matched command's audience before options parse). */
export function defaultCliFormat(args: readonly string[]): CliFormat {
	return args[0] === "crew" && args[1] === "init" ? "text" : "toon";
}

/** Valid explicit --format from argv, or undefined (invalid/absent are not overrides). */
function explicitValidFormat(args: readonly string[]): CliFormat | undefined {
	const hasExplicit = args.some((arg) => arg === "--format" || arg.startsWith("--format="));
	if (!hasExplicit) return undefined;
	// requestedFormat silently falls back to toon on malformed values; a malformed
	// explicit format is not an override, so detect validity independently.
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--format") {
			const value = args[index + 1];
			if (value === "toon" || value === "json" || value === "text") return value;
			return undefined;
		}
		if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length);
			if (value === "toon" || value === "json" || value === "text") return value;
			return undefined;
		}
	}
	return undefined;
}

/** Format for usage errors: explicit valid override wins, else the matched command's default. */
export function cliFormatForArgs(args: readonly string[]): CliFormat {
	return explicitValidFormat(args) ?? defaultCliFormat(args);
}

function explicitHomeFormat(args: readonly string[]): CliFormat | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const raw = arg.startsWith("--format=")
			? arg.slice("--format=".length)
			: arg === "--format"
				? args[index + 1]
				: undefined;
		if (raw === undefined) continue;
		if (raw === "toon" || raw === "json" || raw === "text") return raw;
		throw new UsageError(`Invalid --format '${raw}'; valid alternatives: toon, json, text`);
	}
	return undefined;
}

export function parseHomeFormat(args: readonly string[]): CliFormat {
	return explicitHomeFormat(args) ?? defaultCliFormat(args);
}
