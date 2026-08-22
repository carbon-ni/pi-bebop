import path from "node:path";
import { MAX_MESSAGE_INSTRUCTIONS, MAX_MESSAGE_ORIGIN_FIELD_BYTES } from "../domain/index.ts";

export type CliFormat = "toon" | "json" | "text";
export interface SendCliOptions {
	command: "send";
	socketPath: string;
	message?: string;
	instructions: string[];
	origin?: { kind: "external"; label: string };
	stdin: boolean;
	mode: "steer" | "follow_up";
	wait: "turn_end" | "accepted";
	timeoutMs: number;
	format: CliFormat;
	full: boolean;
}

export class UsageError extends Error {
	readonly code = "usage";
}

function duration(value: string): number {
	const match = /^(\d+)(ms|s|m)$/.exec(value);
	if (!match || Number(match[1]) < 1)
		throw new UsageError(`Invalid --timeout '${value}'; use a positive duration such as 500ms, 30s, or 5m`);
	const multiplier = match[2] === "m" ? 60000 : match[2] === "s" ? 1000 : 1;
	const result = Number(match[1]) * multiplier;
	if (!Number.isSafeInteger(result)) throw new UsageError(`Invalid --timeout '${value}'; duration is too large`);
	return result;
}

export function parseCliArguments(args: string[], cwd = process.cwd()): SendCliOptions {
	if (args[0] !== "send") throw new UsageError(`Invalid command '${args[0] ?? ""}'; valid command: send`);
	const values = new Map<string, string>();
	const instructions: string[] = [];
	let origin: { kind: "external"; label: string } | undefined;
	let stdin = false;
	let full = false;
	const valueFlags = new Set([
		"--socket",
		"--message",
		"--mode",
		"--wait",
		"--timeout",
		"--format",
		"--instruction",
		"--from",
	]);
	for (let index = 1; index < args.length; index += 1) {
		const rawFlag = args[index]!;
		const equals = rawFlag.indexOf("=");
		const flag = equals > 0 ? rawFlag.slice(0, equals) : rawFlag;
		const inlineValue = equals > 0 ? rawFlag.slice(equals + 1) : undefined;
		if (flag === "--stdin" || flag === "--full") {
			if ((flag === "--stdin" && stdin) || (flag === "--full" && full))
				throw new UsageError(`Duplicate flag: ${flag}`);
			if (flag === "--stdin") stdin = true;
			else full = true;
			continue;
		}
		if (!valueFlags.has(flag))
			throw new UsageError(
				`Unknown flag '${flag}'; valid flags: --socket, --message, --stdin, --instruction, --from, --mode, --wait, --timeout, --format, --full`,
			);
		if (flag === "--instruction") {
			let value = inlineValue ?? args[++index];
			let escaped = false;
			if (value === "--") {
				value = args[++index];
				escaped = true;
			}
			if (value === undefined || (inlineValue === undefined && !escaped && value.startsWith("--")))
				throw new UsageError("Missing value for --instruction");
			instructions.push(value);
			if (instructions.length > MAX_MESSAGE_INSTRUCTIONS)
				throw new UsageError(`Too many --instruction values; maximum is ${MAX_MESSAGE_INSTRUCTIONS}`);
			continue;
		}
		if (values.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
		let value = inlineValue ?? args[++index];
		let escaped = false;
		if (value === "--") {
			value = args[++index];
			escaped = true;
		}
		if (value === undefined || (inlineValue === undefined && !escaped && value.startsWith("--")))
			throw new UsageError(`Missing value for ${flag}`);
		values.set(flag, value);
	}
	const socket = values.get("--socket");
	if (!socket) throw new UsageError("Missing required --socket <path>");
	const message = values.get("--message");
	const from = values.get("--from");
	if (from !== undefined) {
		if (
			from.trim().length === 0 ||
			from !== from.trim() ||
			from.includes("\0") ||
			Buffer.byteLength(from, "utf8") > MAX_MESSAGE_ORIGIN_FIELD_BYTES
		)
			throw new UsageError(
				"--from must be trimmed, non-empty, within the UTF-8 byte limit, and must not contain NUL",
			);
		origin = { kind: "external", label: from };
	}
	if (message !== undefined && stdin)
		throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
	if (message === undefined && !stdin)
		throw new UsageError("Missing message source; use --message <text> or --stdin");
	if (message !== undefined && message.length === 0) throw new UsageError("--message must not be empty");
	const mode = values.get("--mode") ?? "steer";
	if (mode !== "steer" && mode !== "follow_up")
		throw new UsageError(`Invalid --mode '${mode}'; valid alternatives: steer, follow_up`);
	const wait = values.get("--wait") ?? "turn_end";
	if (wait !== "turn_end" && wait !== "accepted")
		throw new UsageError(`Invalid --wait '${wait}'; valid alternatives: turn_end, accepted`);
	const format = values.get("--format") ?? "toon";
	if (format !== "toon" && format !== "json" && format !== "text")
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return {
		command: "send",
		socketPath: path.resolve(cwd, socket),
		message,
		instructions,
		...(origin === undefined ? {} : { origin }),
		stdin,
		mode,
		wait,
		timeoutMs: duration(values.get("--timeout") ?? "5m"),
		format,
		full,
	};
}
