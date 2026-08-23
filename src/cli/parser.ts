import path from "node:path";
import { CommanderError } from "commander";
import { createCliRegistry } from "./registry.ts";
import { isCliFormat } from "./commands/crew-init.ts";
import { UsageError, type CliFormat } from "./arguments.ts";

export interface DeclarativeCrewInitOptions {
	readonly command: "crew-init";
	readonly project?: string;
	readonly format: CliFormat;
	readonly help?: boolean;
}

const VALID_FLAGS = "--project <directory>, --format toon|json|text, --help";
const VALUE_FLAGS = new Set(["--project", "--format"]);
const FORMAT_ALTERNATIVES = "toon, json, text";

/**
 * TASK-0057 parser facade: Commander owns tokenization only. Duplicate-flag
 * rejection, the `--` sentinel escape, help detection, enum validation, path
 * resolution, and error message mapping are application-owned (0056 decision:
 * cross-flag/domain validation, trust/path policy, output rendering, IO, and
 * exit assignment stay outside the framework).
 *
 * Injected argv/output guarantees: parse uses an explicit argv array,
 * `exitOverride()` throws CommanderError instead of process.exit, and
 * `configureOutput` routes library writes to no-ops — the facade never writes
 * to stdout/stderr and never calls process.exit (verified by parser tests).
 */
export function parseCrewInitCommand(args: string[], cwd = process.cwd()): DeclarativeCrewInitOptions {
	// 1. App-owned pre-pass: help detection, duplicate rejection, `--` sentinel.
	const tokens: string[] = [];
	let help = false;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const raw = args[index]!;
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (VALUE_FLAGS.has(flag)) {
			if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
			seen.add(flag);
			if (equals > 0) {
				tokens.push(raw);
				continue;
			}
			// `--` sentinel: --project -- value escapes flag-like values.
			if (args[index + 1] === "--" && args[index + 2] !== undefined) {
				tokens.push(`${flag}=${args[index + 2]}`);
				index += 2;
				continue;
			}
			tokens.push(raw);
			continue;
		}
		tokens.push(raw);
	}

	// 2. Commander tokenization with injected argv and no ambient IO.
	const program = createCliRegistry()
		.crewInit()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	let opts: { project?: string; format?: string };
	try {
		program.parse(tokens, { from: "user" });
		opts = program.opts();
	} catch (error) {
		if (error instanceof CommanderError) throw mapCommanderError(error);
		throw error;
	}

	// 3. App-owned cross-flag/domain validation.
	const format = (opts.format ?? "toon") as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: ${FORMAT_ALTERNATIVES}`);
	const project = opts.project;
	return {
		command: "crew-init",
		...(project === undefined ? {} : { project: path.resolve(cwd, project) }),
		format,
		...(help ? { help: true } : {}),
	};
}

/** Maps CommanderError to the byte-compatible UsageError messages locked by the 0056 suite. */
function mapCommanderError(error: CommanderError): UsageError {
	if (error.code === "commander.optionMissingArgument") {
		const match = /--[a-z-]+/.exec(error.message);
		const flag = match?.[0] ?? "--format";
		return new UsageError(`Missing value for ${flag}`);
	}
	if (error.code === "commander.unknownOption") {
		const match = /unknown option '(--?[^']+)'/.exec(error.message);
		const flag = match?.[1] ?? "";
		return new UsageError(`Unknown flag '${flag}'; valid flags: ${VALID_FLAGS}`);
	}
	if (error.code === "commander.excessArguments") {
		const match = /got \d+: ([^\n.]+)/.exec(error.message);
		const positional = match?.[1]?.split(",")[0]?.trim() ?? "";
		return new UsageError(`Unknown flag '${positional}'; valid flags: ${VALID_FLAGS}`);
	}
	return new UsageError(error.message);
}
