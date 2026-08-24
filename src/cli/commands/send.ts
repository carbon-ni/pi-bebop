import { Command } from "commander";
import { MAX_MESSAGE_INSTRUCTIONS } from "../../domain/index.ts";
import type { CliFormat } from "../arguments.ts";

/**
 * TASK-0058: declarative Commander schema for `send` — the single flag
 * definition replacing the hand-written token loop. Commander owns
 * tokenization only; cross-flag/domain validation, path resolution, and error
 * mapping stay in the parser facade (app-owned, per the 0056 decision).
 *
 * Help is generated from this command's metadata (AC: "generated from its
 * command metadata and reflects defaults plus runnable direct/Intake examples")
 * and is deterministic human text with zero operational IO.
 */

function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

export function buildSendCommand(): Command {
	return new Command("send")
		.description("Deliver a message to a Pi session (--socket) or durable Crew Intake (--crew)")
		.option("--socket <path>", "Direct delivery socket path")
		.option("--crew <manifest>", "Crew manifest path (durable intake, caller consent)")
		.option("--message <text>", "Message text")
		.option("--stdin", "Read message from stdin")
		.option("--instruction <value>", "Instruction (repeatable, ordered)", collect, [])
		.option("--from <label>", "Claimed external origin label")
		.option("--mode <mode>", "steer or follow_up", "steer")
		.option("--wait <wait>", "turn_end or accepted", "turn_end")
		.option("--timeout <duration>", "Duration such as 500ms, 30s, or 5m", "5m")
		.option("--format <format>", "toon, json, or text", "toon")
		.option("--full", "Full response without truncation")
		.showHelpAfterError(false)
		.helpOption(false); // --help handled by the app pre-pass; no short aliases
}

export interface SendLeafOptions {
	readonly socketPath?: string;
	readonly crewPath?: string;
	readonly message?: string;
	readonly instructions: string[];
	readonly origin?: { kind: "external"; label: string };
	readonly stdin: boolean;
	readonly mode: string;
	readonly wait: string;
	readonly timeout: string;
	readonly format: string;
	readonly full: boolean;
}

export function readSendLeafOptions(parsed: Command): SendLeafOptions {
	const opts = parsed.opts<{
		socket?: string;
		crew?: string;
		message?: string;
		instruction?: string[];
		from?: string;
		stdin?: boolean;
		mode?: string;
		wait?: string;
		timeout?: string;
		format?: string;
		full?: boolean;
	}>();
	return {
		...(opts.socket === undefined ? {} : { socketPath: opts.socket }),
		...(opts.crew === undefined ? {} : { crewPath: opts.crew }),
		...(opts.message === undefined ? {} : { message: opts.message }),
		instructions: opts.instruction ?? [],
		...(opts.from === undefined ? {} : { origin: { kind: "external" as const, label: opts.from } }),
		stdin: opts.stdin ?? false,
		mode: opts.mode ?? "steer",
		wait: opts.wait ?? "turn_end",
		timeout: opts.timeout ?? "5m",
		format: opts.format ?? "toon",
		full: opts.full ?? false,
	};
}

/** Deterministic local help generated from command metadata (defaults + runnable examples). */
export function sendHelp(program: Command = buildSendCommand()): string {
	const lines: string[] = [
		"pi-bebop send (--socket <path> | --crew <manifest>) (--message <text> | --stdin) [options]",
		"",
		program.description(),
		"",
		"Options:",
	];
	for (const option of program.options) {
		const flags = option.flags;
		const description = option.description;
		const hasDefault = option.defaultValue !== undefined;
		const defaultText = hasDefault ? ` (default: ${String(option.defaultValue)})` : "";
		lines.push(`  ${flags}   ${description}${defaultText}`);
	}
	lines.push(
		"",
		`Repeated --instruction values are collected in order (maximum ${MAX_MESSAGE_INSTRUCTIONS}).`,
		"",
		"Examples:",
		'  pi-bebop send --socket .pi/bebop/sockets/dev.sock --message "hello"',
		'  pi-bebop send --crew .pi/bebop/crew.json --message "persisted intake" --from CI',
		"  pi-bebop send --socket .pi/bebop/sockets/dev.sock --stdin --mode follow_up",
		"",
	);
	return lines.join("\n");
}
