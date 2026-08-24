import path from "node:path";
import { CommanderError } from "commander";
import { createCliRegistry } from "./registry.ts";
import { isCliFormat } from "./commands/crew-init.ts";
import { readSendLeafOptions, type SendLeafOptions } from "./commands/send.ts";
import { MAX_MESSAGE_INSTRUCTIONS, MAX_MESSAGE_ORIGIN_FIELD_BYTES } from "../domain/index.ts";
import { UsageError, type CliFormat, type CliCommand, type HomeCliOptions, type SendCliOptions } from "./arguments.ts";

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

// ============================================================================
// TASK-0058: declarative send parser (replaces the hand-written token loop)
// ============================================================================

const SEND_VALID_FLAGS =
	"--socket, --message, --stdin, --instruction, --from, --mode, --wait, --timeout, --format, --full";
const SEND_SINGLE_VALUE_FLAGS = new Set([
	"--socket",
	"--crew",
	"--message",
	"--mode",
	"--wait",
	"--timeout",
	"--format",
	"--from",
]);
const SEND_BOOLEAN_FLAGS = new Set(["--stdin", "--full"]);

function sendDuration(value: string): number {
	const match = /^(\d+)(ms|s|m)$/.exec(value);
	if (!match || Number(match[1]) < 1)
		throw new UsageError(`Invalid --timeout '${value}'; use a positive duration such as 500ms, 30s, or 5m`);
	const multiplier = match[2] === "m" ? 60000 : match[2] === "s" ? 1000 : 1;
	const result = Number(match[1]) * multiplier;
	if (!Number.isSafeInteger(result)) throw new UsageError(`Invalid --timeout '${value}'; duration is too large`);
	return result;
}

function validateOriginLabel(label: string): void {
	if (
		label.trim().length === 0 ||
		label !== label.trim() ||
		label.includes("\0") ||
		Buffer.byteLength(label, "utf8") > MAX_MESSAGE_ORIGIN_FIELD_BYTES
	)
		throw new UsageError(
			"--from must be trimmed, non-empty, within the UTF-8 byte limit, and must not contain NUL",
		);
}

/** App-owned cross-flag/domain validation producing the exact legacy messages. */
function validateSendSemantics(leaf: SendLeafOptions, seen: Set<string>, cwd: string): SendCliOptions {
	const hasSocket = leaf.socketPath !== undefined;
	const hasCrew = leaf.crewPath !== undefined;
	if (hasSocket === hasCrew)
		throw new UsageError(
			"Choose exactly one target: --socket <path> for direct delivery or --crew <manifest> for durable intake",
		);
	if (hasCrew) {
		for (const incompatible of ["--mode", "--wait", "--timeout"] as const) {
			if (seen.has(incompatible))
				throw new UsageError(
					`${incompatible} is not supported with --crew; external intake is one-way persisted delivery`,
				);
		}
	}
	if (leaf.origin !== undefined) validateOriginLabel(leaf.origin.label);
	const hasMessage = leaf.message !== undefined;
	if (hasMessage && leaf.stdin)
		throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
	if (!hasMessage && !leaf.stdin) throw new UsageError("Missing message source; use --message <text> or --stdin");
	if (hasMessage && leaf.message!.length === 0) throw new UsageError("--message must not be empty");
	if (leaf.mode !== "steer" && leaf.mode !== "follow_up")
		throw new UsageError(`Invalid --mode '${leaf.mode}'; valid alternatives: steer, follow_up`);
	if (leaf.wait !== "turn_end" && leaf.wait !== "accepted")
		throw new UsageError(`Invalid --wait '${leaf.wait}'; valid alternatives: turn_end, accepted`);
	if (!isCliFormat(leaf.format))
		throw new UsageError(`Invalid --format '${leaf.format}'; valid alternatives: toon, json, text`);
	return {
		command: "send",
		...(hasSocket ? { socketPath: path.resolve(cwd, leaf.socketPath!) } : {}),
		...(hasCrew ? { crewPath: path.resolve(cwd, leaf.crewPath!) } : {}),
		...(hasMessage ? { message: leaf.message } : {}),
		instructions: leaf.instructions,
		...(leaf.origin === undefined ? {} : { origin: leaf.origin }),
		stdin: leaf.stdin,
		mode: leaf.mode as "steer" | "follow_up",
		wait: leaf.wait as "turn_end" | "accepted",
		timeoutMs: sendDuration(leaf.timeout),
		format: leaf.format as CliFormat,
		full: leaf.full,
	};
}

/**
 * Declarative `send` parser (TASK-0058). Same facade discipline as crew init:
 * app-owned pre-pass (duplicate rejection, `--` sentinel, help detection),
 * Commander tokenization with injected argv/exitOverride/no-op streams, and
 * app-owned cross-flag validation. Returns the same typed SendCliOptions
 * semantics as the characterized parser.
 */
export function parseSendCommand(args: string[], cwd = process.cwd()): SendCliOptions & { help?: boolean } {
	// 1. Pre-pass: help, duplicates, `--` sentinel escape.
	const tokens: string[] = [];
	let help = false;
	const seen = new Set<string>();
	const instructionValues: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const raw = args[index]!;
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (flag === "--instruction") {
			let value: string | undefined;
			let escaped = false;
			if (equals > 0) value = raw.slice(equals + 1);
			else if (args[index + 1] === "--" && args[index + 2] !== undefined) {
				value = args[index + 2];
				escaped = true;
				index += 2;
			} else value = args[++index];
			if (value === undefined || (equals < 0 && !escaped && value.startsWith("--")))
				throw new UsageError("Missing value for --instruction");
			instructionValues.push(value);
			if (instructionValues.length > MAX_MESSAGE_INSTRUCTIONS)
				throw new UsageError(`Too many --instruction values; maximum is ${MAX_MESSAGE_INSTRUCTIONS}`);
			continue;
		}
		if (SEND_SINGLE_VALUE_FLAGS.has(flag) || SEND_BOOLEAN_FLAGS.has(flag)) {
			if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
			seen.add(flag);
			if (SEND_BOOLEAN_FLAGS.has(flag) || equals > 0) {
				tokens.push(raw);
				continue;
			}
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

	// 2. Commander tokenization.
	const program = createCliRegistry()
		.send()
		.exitOverride()
		.configureOutput({
			writeOut: () => {},
			writeErr: () => {},
			outputError: () => {},
		});
	let leaf: SendLeafOptions;
	try {
		program.parse(tokens, { from: "user" });
		leaf = readSendLeafOptions(program);
	} catch (error) {
		if (error instanceof CommanderError) throw mapSendCommanderError(error);
		throw error;
	}
	if (instructionValues.length > 0) leaf = { ...leaf, instructions: instructionValues };

	// 3. App-owned semantic validation. Help short-circuits the cross-flag XOR
	// checks (no target/message requirement) but still validates and resolves
	// every provided value, consistent with crew init; main renders the
	// deterministic help with zero IO.
	if (help) {
		if (leaf.origin !== undefined) validateOriginLabel(leaf.origin.label);
		if (!isCliFormat(leaf.format))
			throw new UsageError(`Invalid --format '${leaf.format}'; valid alternatives: toon, json, text`);
		return {
			command: "send",
			...(leaf.socketPath === undefined ? {} : { socketPath: path.resolve(cwd, leaf.socketPath) }),
			...(leaf.crewPath === undefined ? {} : { crewPath: path.resolve(cwd, leaf.crewPath) }),
			...(leaf.message === undefined ? {} : { message: leaf.message }),
			instructions: leaf.instructions,
			...(leaf.origin === undefined ? {} : { origin: leaf.origin }),
			stdin: leaf.stdin,
			mode: leaf.mode as "steer" | "follow_up",
			wait: leaf.wait as "turn_end" | "accepted",
			timeoutMs: sendDuration(leaf.timeout),
			format: leaf.format as CliFormat,
			full: leaf.full,
			help: true,
		};
	}
	const options = validateSendSemantics(leaf, seen, cwd);
	return options;
}

function mapSendCommanderError(error: CommanderError): UsageError {
	if (error.code === "commander.optionMissingArgument") {
		const match = /--[a-z-]+/.exec(error.message);
		const flag = match?.[0] ?? "--message";
		return new UsageError(`Missing value for ${flag}`);
	}
	if (error.code === "commander.unknownOption") {
		const match = /unknown option '(--?[^']+)'/.exec(error.message);
		const flag = match?.[1] ?? "";
		return new UsageError(`Unknown flag '${flag}'; valid flags: ${SEND_VALID_FLAGS}`);
	}
	if (error.code === "commander.excessArguments") {
		const match = /got \d+: ([^\n.]+)/.exec(error.message);
		const positional = match?.[1]?.split(",")[0]?.trim() ?? "";
		return new UsageError(`Unknown flag '${positional}'; valid flags: ${SEND_VALID_FLAGS}`);
	}
	return new UsageError(error.message);
}

// ============================================================================
// TASK-0063: top-level parse dispatch (moved here so arguments.ts stays a pure
// type/error module — arguments↔parser had a runtime import cycle).
// ============================================================================

/**
 * Compatibility surface for the characterized `send` parser (same signature and
 * semantics as the deleted token loop). Validates the command word, then
 * delegates tokenization + semantic validation to the declarative facade.
 */
export function parseCliArguments(args: string[], cwd = process.cwd()): SendCliOptions {
	if (args[0] !== "send") throw new UsageError(`Invalid command '${args[0] ?? ""}'; valid command: send`);
	return parseSendCommand(args.slice(1), cwd);
}

/**
 * Top-level command dispatch. Exactly two commands are supported: `send`
 * (declarative since TASK-0058) and `crew init` (declarative since TASK-0057),
 * plus the no-argument home state. Unknown commands report valid alternatives
 * and exit 2 before any filesystem/network dependency is called.
 */
export function parseCliCommand(args: string[], cwd = process.cwd()): CliCommand {
	if (args.length === 0) return { command: "home" };
	const command = args[0];
	if (command === "send") return parseCliArguments(args, cwd);
	if (command !== "crew") throw new UsageError(`Invalid command '${command ?? ""}'; valid commands: send, crew init`);
	if (args[1] !== "init") throw new UsageError(`Invalid command 'crew ${args[1] ?? ""}'; valid command: crew init`);
	return parseCrewInitCommand(args.slice(2), cwd);
}
