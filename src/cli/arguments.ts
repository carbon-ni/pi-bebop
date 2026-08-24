import { parseCrewInitCommand, parseSendCommand } from "./parser.ts";

/**
 * TASK-0058: this module is reduced to types and the top-level dispatch.
 * The hand-written send token loop and duration/origin validators were deleted;
 * tokenization is owned by Commander (see commands/send.ts, commands/crew-init.ts)
 * and cross-flag/domain validation lives in the parser facade (parser.ts),
 * both per the 0056 framework boundary.
 */

export type CliFormat = "toon" | "json" | "text";
export interface SendCliOptions {
	command: "send";
	socketPath?: string;
	crewPath?: string;
	message?: string;
	instructions: string[];
	origin?: { kind: "external"; label: string };
	stdin: boolean;
	mode: "steer" | "follow_up";
	wait: "turn_end" | "accepted";
	timeoutMs: number;
	format: CliFormat;
	full: boolean;
	/** Additive command-local help (TASK-0058 AC 6); only present when requested. */
	help?: boolean;
}

export class UsageError extends Error {
	readonly code = "usage";
}

export type CrewInitCliOptions = {
	readonly command: "crew-init";
	readonly project?: string;
	readonly format: CliFormat;
	readonly help?: boolean;
};

export type HomeCliOptions = {
	readonly command: "home";
};

export type CliCommand = SendCliOptions | CrewInitCliOptions | HomeCliOptions;

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
