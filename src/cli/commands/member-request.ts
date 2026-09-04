import { Command, CommanderError } from "commander";
import { parsePositiveDurationMs } from "../parser.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { errorResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";
import { readStdinMessage } from "../message-input.ts";
import {
	MAX_MEMBER_REQUEST_TIMEOUT_SECONDS,
	MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	MIN_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
	DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	type RpcCommandResponse,
} from "../../domain/index.ts";

const FORMATS = ["toon", "json", "text"] as const;
type Direction = "inbound" | "outbound" | "all";
export type MemberRequestCliOptions = {
	readonly command: "member-request-send" | "member-request-list" | "member-request-wait" | "member-request-respond";
	readonly session?: string;
	readonly member?: string;
	readonly requestId?: string;
	readonly message?: string;
	readonly stdin: boolean;
	readonly instructions: string[];
	readonly responseGraceSeconds: number;
	readonly maxWaitSeconds: number;
	readonly direction: Direction;
	readonly format: CliFormat;
	readonly help?: boolean;
};

function collect(value: string, previous: string[]): string[] {
	return previous.concat(value);
}
function parseDuration(value: string, label: string, min: number, max: number): number {
	let ms: number;
	try {
		ms = parsePositiveDurationMs(value);
	} catch {
		throw new UsageError(`Invalid ${label} '${value}'; use a whole-second duration`);
	}
	if (ms % 1000 !== 0 || ms < min * 1000 || ms > max * 1000)
		throw new UsageError(`Invalid ${label} '${value}'; use a whole-second duration from ${min}s through ${max}s`);
	return ms / 1000;
}
function parserFor(
	command: Command,
	args: readonly string[],
): { options: Record<string, unknown>; positional: string[]; help: boolean; instructions: string[] } {
	const tokens: string[] = [];
	const instructions: string[] = [];
	let help = false;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const raw = args[index]!;
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (flag === "--instruction") {
			const value = equals > 0 ? raw.slice(equals + 1) : args[++index];
			if (!value || value.startsWith("--")) throw new UsageError("Missing value for --instruction");
			instructions.push(value);
			continue;
		}
		if (["--session", "--message", "--response-grace", "--max-wait", "--direction", "--format"].includes(flag)) {
			if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
			seen.add(flag);
		}
		tokens.push(raw);
	}
	const program = command
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	try {
		program.parse(tokens, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) {
			if (help) return { options: program.opts(), positional: program.args, help, instructions };
			throw new UsageError(error.message);
		}
		throw error;
	}
	return { options: program.opts(), positional: program.args, help, instructions };
}
function baseCommand(name: string, description: string): Command {
	return new Command(name)
		.description(description)
		.option("--session <id|alias>", "Source joined Pi session (default: PI_SESSION_ID)")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.showHelpAfterError(false)
		.helpOption(false);
}
export function buildMemberRequestSendCommand(): Command {
	return baseCommand("send", "Send one correlated Member Request")
		.argument("<member>", "Crew member name or unique role")
		.option("--message <text>", "Request message")
		.option("--stdin", "Read request message from stdin")
		.option("--instruction <text>", "Instruction (repeatable, ordered)", collect, [])
		.option("--response-grace <duration>", "Post-idle Response grace (default 120s)", "120s")
		.option("--max-wait <duration>", "Absolute accepted-request safety (default 30m)", "30m");
}
export function buildMemberRequestListCommand(): Command {
	return baseCommand("list", "List bounded Member Request metadata").option(
		"--direction <direction>",
		"inbound, outbound, or all",
		"all",
	);
}
export function buildMemberRequestWaitCommand(): Command {
	return baseCommand("wait", "Wait for one exact Request outcome").argument(
		"<request-id>",
		"Opaque outbound Request ID",
	);
}
export function buildMemberRequestRespondCommand(): Command {
	return baseCommand("respond", "Send one Response to one exact inbound Request")
		.argument("<request-id>", "Opaque inbound Request ID")
		.option("--message <text>", "Response message")
		.option("--stdin", "Read response message from stdin")
		.option("--instruction <text>", "Instruction (repeatable, ordered)", collect, []);
}
function format(value: unknown): CliFormat {
	if (!FORMATS.includes(value as CliFormat))
		throw new UsageError(`Invalid --format '${String(value)}'; valid alternatives: toon, json, text`);
	return value as CliFormat;
}
function messageOptions(parsed: ReturnType<typeof parserFor>, opts: Record<string, unknown>, requireMessage: boolean) {
	const message = typeof opts.message === "string" ? opts.message : undefined;
	const stdin = opts.stdin === true;
	if (requireMessage && message === undefined && !stdin)
		throw new UsageError("Missing message source; use --message <text> or --stdin");
	if (message !== undefined && stdin)
		throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
	if (message !== undefined && message.trim().length === 0) throw new UsageError("--message must not be empty");
	return { message, stdin, instructions: parsed.instructions };
}
export function parseMemberRequestSendCommand(args: readonly string[]): MemberRequestCliOptions {
	const parsed = parserFor(buildMemberRequestSendCommand(), args);
	const opts = parsed.options;
	if (parsed.help)
		return {
			command: "member-request-send",
			member: "",
			stdin: false,
			instructions: [],
			responseGraceSeconds: DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
			maxWaitSeconds: DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
			direction: "all",
			format: format(opts.format ?? "toon"),
			help: true,
		};
	const member = parsed.positional[0];
	if (!member || member.trim() !== member)
		throw new UsageError("Missing <member>; provide a crew member name or unique role");
	const msg = messageOptions(parsed, opts, true);
	const grace = parseDuration(
		String(opts.responseGrace ?? "120s"),
		"--response-grace",
		1,
		MAX_MEMBER_REQUEST_TIMEOUT_SECONDS,
	);
	const max = parseDuration(
		String(opts.maxWait ?? "30m"),
		"--max-wait",
		MIN_MEMBER_REQUEST_MAX_WAIT_SECONDS,
		MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	);
	if (max <= grace) throw new UsageError("--max-wait must be strictly greater than --response-grace");
	return {
		command: "member-request-send",
		member,
		...(opts.session === undefined ? {} : { session: String(opts.session) }),
		...msg,
		responseGraceSeconds: grace,
		maxWaitSeconds: max,
		direction: "all",
		format: format(opts.format ?? "toon"),
	};
}
export function parseMemberRequestListCommand(args: readonly string[]): MemberRequestCliOptions {
	const parsed = parserFor(buildMemberRequestListCommand(), args);
	const opts = parsed.options;
	const direction = String(opts.direction ?? "all");
	if (!["inbound", "outbound", "all"].includes(direction))
		throw new UsageError("Invalid --direction; valid alternatives: inbound, outbound, all");
	return {
		command: "member-request-list",
		...(opts.session === undefined ? {} : { session: String(opts.session) }),
		stdin: false,
		instructions: [],
		responseGraceSeconds: DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
		maxWaitSeconds: DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
		direction: direction as Direction,
		format: format(opts.format ?? "toon"),
		...(parsed.help ? { help: true } : {}),
	};
}
function parseIdCommand(
	args: readonly string[],
	command: "member-request-wait" | "member-request-respond",
): MemberRequestCliOptions {
	const parsed = parserFor(
		command === "member-request-wait" ? buildMemberRequestWaitCommand() : buildMemberRequestRespondCommand(),
		args,
	);
	const opts = parsed.options;
	const id = parsed.positional[0];
	if (parsed.help)
		return {
			command,
			requestId: "",
			stdin: false,
			instructions: [],
			responseGraceSeconds: DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
			maxWaitSeconds: DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
			direction: "all",
			format: format(opts.format ?? "toon"),
			help: true,
		};
	if (!id || id.trim() !== id) throw new UsageError("Missing exact <request-id>");
	const msg =
		command === "member-request-respond"
			? messageOptions(parsed, opts, true)
			: { message: undefined, stdin: false, instructions: parsed.instructions };
	return {
		command,
		requestId: id,
		...(opts.session === undefined ? {} : { session: String(opts.session) }),
		...msg,
		responseGraceSeconds: DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
		maxWaitSeconds: DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
		direction: "all",
		format: format(opts.format ?? "toon"),
	};
}
export function parseMemberRequestWaitCommand(args: readonly string[]) {
	return parseIdCommand(args, "member-request-wait");
}
export function parseMemberRequestRespondCommand(args: readonly string[]) {
	return parseIdCommand(args, "member-request-respond");
}
export function memberRequestHelp(kind: "send" | "list" | "wait" | "respond"): string {
	const text: Record<typeof kind, string> = {
		send: "pi-bebop member request send <member> (--message <text> | --stdin) [--response-grace <duration>] [--max-wait <duration>] [--instruction <text>...] [--session <id|alias>] [--format toon|json|text]",
		list: "pi-bebop member request list [--session <id|alias>] [--direction inbound|outbound|all] [--format toon|json|text]",
		wait: "pi-bebop member request wait <request-id> [--session <id|alias>] [--format toon|json|text]",
		respond:
			"pi-bebop member request respond <request-id> (--message <text> | --stdin) [--instruction <text>...] [--session <id|alias>] [--format toon|json|text]",
	};
	return (
		text[kind] +
		"\n\nRequest IDs are opaque. Send returns accepted; wait consumes exactly one terminal outcome; respond requires the exact inbound ID."
	);
}

export interface MemberRequestCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly send: (
		source: SourceResolution & { ok: true },
		command: any,
		timeoutMs: number,
		signal: AbortSignal,
	) => Promise<{ response: RpcCommandResponse }>;
	readonly readStdin: typeof readStdinMessage;
	readonly environmentSession: () => string | undefined;
}
function sourceOrError(options: MemberRequestCliOptions, deps: MemberRequestCliDependencies) {
	return deps.resolveSource({ explicitSession: options.session, environmentSession: deps.environmentSession() });
}
async function sendSource(
	source: SourceResolution & { ok: true },
	command: any,
	timeoutMs: number,
	signal: AbortSignal,
	deps: MemberRequestCliDependencies,
) {
	try {
		return await deps.send(source, command, timeoutMs, signal);
	} catch (error) {
		throw error;
	}
}
export const defaultMemberRequestCliDependencies: MemberRequestCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	send: async (source, command, timeoutMs, signal) => {
		try {
			return await sendRpcCommand(source.idSocketPath, command, { timeout: timeoutMs, signal });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return sendRpcCommand(source.aliasSocketPath, command, { timeout: timeoutMs, signal });
		}
	},
	readStdin: readStdinMessage,
	environmentSession: () => process.env.PI_SESSION_ID,
};
function failure(options: MemberRequestCliOptions, target: string, error: unknown): CliOutcome {
	const code =
		error instanceof RpcProtocolError
			? error.code === "remote-error"
				? error.message.replace(/^remote-error:\s*/, "")
				: error.code
			: error instanceof Error && error.name === "AbortError"
				? "aborted"
				: error instanceof Error && /timeout/i.test(error.message)
					? "timeout"
					: "offline";
	const base = errorResult(
		`Member Request failed: ${error instanceof Error ? error.message : String(error)}`,
		target,
		code,
	);
	return {
		kind: "result",
		result: options.requestId ? { ...base, data: { requestId: options.requestId } } : base,
		format: options.format,
		full: false,
	};
}
async function runWithSource(
	options: MemberRequestCliOptions,
	context: CliContext,
	deps: MemberRequestCliDependencies,
	command: any,
	timeoutMs: number,
): Promise<CliOutcome> {
	const source = sourceOrError(options, deps);
	if (source.ok === false) {
		const base = errorResult(source.message, options.session ?? "", source.code);
		return {
			kind: "result",
			result: options.requestId ? { ...base, data: { requestId: options.requestId } } : base,
			format: options.format,
			full: false,
		};
	}
	try {
		const result = await sendSource(source, command, timeoutMs, context.signal, deps);
		if (!result.response.success)
			return failure(
				options,
				options.requestId ?? options.member ?? "member-request",
				new Error(result.response.error ?? "remote-rejected"),
			);
		const data = result.response.data;
		const status =
			command.type === "member_request_wait"
				? typeof (data as { kind?: unknown })?.kind === "string"
					? String((data as { kind: string }).kind)
					: "response"
				: command.type === "member_response"
					? "response-accepted"
					: command.type === "member_request_list"
						? "listed"
						: "accepted";
		return {
			kind: "result",
			result: {
				ok: true,
				target: options.requestId ?? options.member ?? "member-request",
				status,
				data,
			},
			format: options.format,
			full: false,
		};
	} catch (error) {
		return failure(options, options.requestId ?? options.member ?? "member-request", error);
	}
}
export async function runMemberRequestCommand(
	options: MemberRequestCliOptions,
	context: CliContext,
	deps: MemberRequestCliDependencies = defaultMemberRequestCliDependencies,
): Promise<CliOutcome> {
	if (options.help)
		return {
			kind: "help",
			text: memberRequestHelp(
				options.command.replace("member-request-", "") as "send" | "list" | "wait" | "respond",
			),
		};
	if (options.command === "member-request-send") {
		let message: string;
		try {
			message = options.stdin ? await deps.readStdin(context.input, context.signal) : options.message!;
		} catch (error) {
			return failure(options, options.member ?? "member-request", error);
		}
		return runWithSource(
			options,
			context,
			deps,
			{
				type: "member_request_start",
				target: options.member!,
				message,
				...(options.instructions.length === 0 ? {} : { instructions: options.instructions }),
				timeoutSeconds: options.responseGraceSeconds,
				maxWaitSeconds: options.maxWaitSeconds,
			},
			10000,
		);
	}
	if (options.command === "member-request-list")
		return runWithSource(
			options,
			context,
			deps,
			{ type: "member_request_list", direction: options.direction },
			10000,
		);
	if (options.command === "member-request-respond") {
		let message: string;
		try {
			message = options.stdin ? await deps.readStdin(context.input, context.signal) : options.message!;
		} catch (error) {
			return failure(options, options.requestId ?? "member-request", error);
		}
		return runWithSource(
			options,
			context,
			deps,
			{
				type: "member_response",
				requestId: options.requestId!,
				message,
				...(options.instructions.length === 0 ? {} : { instructions: options.instructions }),
			},
			10000,
		);
	}
	return runWithSource(
		options,
		context,
		deps,
		{ type: "member_request_wait", requestId: options.requestId! },
		(options.maxWaitSeconds + options.responseGraceSeconds + 10) * 1000,
	);
}
