import { Command, CommanderError } from "commander";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { isMemberMessageResult, MAX_MESSAGE_INSTRUCTIONS, type MemberMessageResult } from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { parseFlagTokens } from "../flags.ts";
import { errorResult, usageResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";
import { readStdinMessage } from "../message-input.ts";

/**
 * TASK-0062: `member follow-up <member>` and `member redirect <member>` —
 * two leaves sharing one module. Each leaf is one registry contribution; the
 * delivery intent is the command type. Both are accepted-delivery commands:
 * there is no `wait_for` flag, and the acknowledgement (member identity,
 * deliveryId, disposition) never implies reply, delivered work, or
 * completion. The handler only resolves the source endpoint, submits the
 * delegated action, maps the result, and renders — target resolution and
 * payload validation run in the source joined session's own member-message
 * operation, never copied into the CLI.
 */

export type MemberMessageIntent = "follow_up" | "redirect";

export interface MemberMessageCliOptions {
	readonly command: "member-follow-up" | "member-redirect";
	readonly intent: MemberMessageIntent;
	readonly member: string;
	/** Raw leaf-command-local `--session` value (session id or alias). */
	readonly session?: string;
	readonly message?: string;
	readonly instructions: string[];
	readonly stdin: boolean;
	readonly format: CliFormat;
	readonly help?: boolean;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];
const MAX_TARGET_BYTES = 256;
const MAX_MESSAGE_BYTES = 1_000_000;
const MAX_INSTRUCTION_BYTES = 100_000;

export function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

function intentWord(intent: MemberMessageIntent): "follow-up" | "redirect" {
	return intent === "follow_up" ? "follow-up" : "redirect";
}

export function buildMemberMessageCommand(intent: MemberMessageIntent, defaultFormat: CliFormat = "toon"): Command {
	const word = intentWord(intent);
	const label = intent === "follow_up" ? "Follow-up" : "Redirect";
	const description =
		intent === "follow_up"
			? "Send a normal follow-up to a joined crew member (accepted-delivery only)"
			: "Insert a message into a crew member's active work (accepted-delivery only)";
	return new Command(word)
		.description(description)
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option("--message <text>", "Message text")
		.option("--stdin", "Read message from stdin")
		.option("--instruction <value>", "Instruction (repeatable, ordered)", collect, [])
		.option(
			"--format <format>",
			`Output format: ${defaultFormat} (default), ${FORMATS.filter((format) => format !== defaultFormat).join(", ")}`,
			defaultFormat,
		)
		.argument("[<member>]", "Crew member name or unique role")
		.showHelpAfterError(false)
		.helpOption(false);
}

function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

export function memberMessageHelp(intent: MemberMessageIntent): string {
	const word = intentWord(intent);
	const delivery =
		intent === "follow_up" ? "waits behind the target's active work" : "enters before the target's next model step";
	return [
		`pi-bebop member ${word} <member> [--session <id|alias>] (--message <text> | --stdin) [--instruction <text>...] [--format toon|json|text]`,
		"",
		`Send a member ${label(intent)} through one already-joined Pi session, which derives`,
		"membership and trust authoritatively. The CLI never loads a crew manifest.",
		"",
		`Delivery: online normal ${label(intent)}; ${delivery}. Accepted means the message was`,
		"accepted for delivery — it NEVER means replied, delivered work, or completed.",
		"There is no wait_for flag: Pi cannot prove delivery-level response correlation.",
		"",
		"Options:",
		"  --session <id|alias>    Source joined Pi session id or alias (default: PI_SESSION_ID)",
		"  --message <text>        Message text (exactly one of --message or --stdin)",
		"  --stdin                 Read the message from stdin",
		"  --instruction <text>    Ordered instruction (repeatable, at most 32)",
		"  --format <format>       toon (default), json, or text",
		"",
		`Discover sessions with: ${SESSION_LIST_HINT}`,
		"",
	].join("\n");
}

function label(intent: MemberMessageIntent): string {
	return intent === "follow_up" ? "Follow-up" : "Redirect";
}

const VALID_FLAGS =
	"--session <id|alias>, --message <text>, --stdin, --instruction <text>, --format toon|json|text, --help";

function mapCommanderError(error: CommanderError): UsageError {
	const match = /--[a-z-]+/.exec(error.message);
	const flag = match?.[0] ?? "--format";
	if (error.code === "commander.optionMissingArgument") return new UsageError(`Missing value for ${flag}`);
	if (error.code === "commander.unknownOption") {
		const unknown = /unknown option '(--?[^']+)'/.exec(error.message)?.[1] ?? "";
		if (unknown.startsWith("--wait"))
			return new UsageError(
				`Unknown flag '${unknown}'; this command is accepted-delivery only and never waits for a reply`,
			);
		return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS}`);
	}
	if (error.code === "commander.excessArguments")
		return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS}`);
	return new UsageError(error.message);
}

const SINGLE_VALUE_FLAGS = new Set(["--session", "--message", "--format"]);

function validateMessageContent(message: string, source: "message" | "stdin"): void {
	if (message.length === 0 || message.trim().length === 0)
		throw new UsageError(`--${source} received empty content; provide UTF-8 message text`);
	if (message.includes("\0")) throw new UsageError(`--${source} must not contain NUL bytes`);
	if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES)
		throw new UsageError(`--${source} exceeds the ${MAX_MESSAGE_BYTES}-byte message limit`);
}

function validateInstructions(instructions: readonly string[]): void {
	if (instructions.length > MAX_MESSAGE_INSTRUCTIONS)
		throw new UsageError(`Too many --instruction values; maximum is ${MAX_MESSAGE_INSTRUCTIONS}`);
	for (const instruction of instructions) {
		if (instruction.length === 0 || instruction !== instruction.trim())
			throw new UsageError("Each --instruction must be trimmed and non-empty");
		if (instruction.includes("\0")) throw new UsageError("--instruction must not contain NUL bytes");
		if (Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES)
			throw new UsageError(`--instruction exceeds the ${MAX_INSTRUCTION_BYTES}-byte limit`);
	}
}

type MemberMessageRawOptions = { session?: string; message?: string; stdin?: boolean; format?: string };

function parseMemberMessageTokens(
	tokens: readonly string[],
	intent: MemberMessageIntent,
	defaultFormat: CliFormat,
): {
	opts: MemberMessageRawOptions;
	member: string;
} {
	const program = buildMemberMessageCommand(intent, defaultFormat)
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	try {
		program.parse(tokens, { from: "user" });
		return { opts: program.opts(), member: program.args[0] ?? "" };
	} catch (error) {
		if (error instanceof CommanderError) throw mapCommanderError(error);
		throw error;
	}
}

function validateMemberMessageOptions(
	opts: MemberMessageRawOptions,
	member: string,
	help: boolean,
	instructions: readonly string[],
	defaultFormat: CliFormat,
): { format: CliFormat; hasMessage: boolean; hasStdin: boolean } {
	const format = (opts.format ?? defaultFormat) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	validateInstructions(instructions);
	if (!help && member.trim().length === 0)
		throw new UsageError("Missing <member>; provide a crew member name or unique role");
	if (!help && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES))
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
	const hasMessage = opts.message !== undefined;
	const hasStdin = opts.stdin === true;
	if (!help) validateMessageSource(opts.message, hasMessage, hasStdin);
	return { format: format as CliFormat, hasMessage, hasStdin };
}

function validateMessageSource(message: string | undefined, hasMessage: boolean, hasStdin: boolean): void {
	if (hasMessage && hasStdin) throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
	if (!hasMessage && !hasStdin) throw new UsageError("Missing message source; use --message <text> or --stdin");
	if (hasMessage && message!.trim().length === 0) throw new UsageError("--message must not be empty");
	if (hasMessage) validateMessageContent(message!, "message");
}

/** App-owned parse facade: pre-pass (help/duplicates/sentinel), Commander tokenization, then validation. */
export function parseMemberMessageCommand(
	args: string[],
	intent: MemberMessageIntent,
	_cwd = process.cwd(),
	defaultFormat: CliFormat = "toon",
): MemberMessageCliOptions {
	const parsed = parseFlagTokens(args, {
		valueFlags: SINGLE_VALUE_FLAGS,
		booleanFlags: new Set(["--stdin"]),
		repeatableFlags: new Set(["--instruction"]),
		escapedValueFlags: new Set([...SINGLE_VALUE_FLAGS, "--instruction"]),
		rejectFlagLikeValues: true,
	});
	const instructions = parsed.repeatableValues.get("--instruction") ?? [];
	const { opts, member } = parseMemberMessageTokens(parsed.tokens, intent, defaultFormat);
	const validated = validateMemberMessageOptions(opts, member, parsed.help, instructions, defaultFormat);
	return {
		command: intent === "follow_up" ? "member-follow-up" : "member-redirect",
		intent,
		member: member.trim(),
		...(opts.session === undefined ? {} : { session: opts.session }),
		...(validated.hasMessage ? { message: opts.message } : {}),
		instructions,
		stdin: validated.hasStdin,
		format: validated.format,
		...(parsed.help ? { help: true } : {}),
	};
}

export interface MemberMessageCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly readStdin: typeof readStdinMessage;
	readonly deliverMessage: (
		source: SourceResolution & { ok: true },
		command: {
			type: "member_follow_up" | "member_redirect";
			target: string;
			message: string;
			instructions: readonly string[];
		},
		signal: AbortSignal,
	) => Promise<{ ok: true; result: MemberMessageResult } | { ok: false; code: string }>;
	readonly environmentSession: () => string | undefined;
}

function mapTransportError(error: unknown): { ok: false; code: string } {
	if (error instanceof RpcProtocolError && error.code === "outcome-unknown")
		return { ok: false, code: "outcome-unknown" };
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
	if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	return { ok: false, code: "transport-error" };
}

async function deliverThroughSocket(
	source: SourceResolution & { ok: true },
	command: {
		type: "member_follow_up" | "member_redirect";
		target: string;
		message: string;
		instructions: readonly string[];
	},
	signal: AbortSignal,
): Promise<{ ok: true; result: MemberMessageResult } | { ok: false; code: string }> {
	const resolved = await resolveMemberEndpoint(source.idSocketPath);
	try {
		const { response } = await sendRpcCommand(
			resolved,
			{
				type: command.type,
				target: command.target,
				message: command.message,
				...(command.instructions.length === 0 ? {} : { instructions: [...command.instructions] }),
			},
			{ timeout: 5000, signal },
		);
		if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
		if (!isMemberMessageResult(response.data)) return { ok: false, code: "malformed-response" };
		return { ok: true, result: response.data };
	} catch (error) {
		if (error instanceof RpcProtocolError && error.code === "remote-error") {
			return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
		}
		throw error;
	}
}

export const defaultMemberMessageCliDependencies: MemberMessageCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	readStdin: readStdinMessage,
	deliverMessage: async (source, command, signal) => {
		try {
			return await deliverThroughSocket(source, command, signal);
		} catch (idError) {
			const mapped = mapTransportError(idError);
			if (mapped.code !== "unknown-session") return mapped;
			// The value may be an alias symlink; fall back once, then report unknown-session.
			try {
				return await deliverThroughSocket({ ...source, idSocketPath: source.aliasSocketPath }, command, signal);
			} catch (aliasError) {
				return mapTransportError(aliasError);
			}
		}
	},
	environmentSession: () => process.env.PI_SESSION_ID,
};

export async function runMemberMessageCommand(
	options: MemberMessageCliOptions,
	context: CliContext,
	deps: MemberMessageCliDependencies = defaultMemberMessageCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: memberMessageHelp(options.intent) };
	const target = options.member;
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(),
	});
	if (!isSourceFailure(source)) {
		let message = options.message;
		if (options.stdin) {
			message = await deps.readStdin(context.input, context.signal);
			validateMessageContent(message, "stdin");
		}
		if (message === undefined) throw new UsageError("Missing message source; use --message <text> or --stdin");
		const outcome = await deps.deliverMessage(
			source,
			{
				type: options.intent === "redirect" ? "member_redirect" : "member_follow_up",
				target,
				message,
				instructions: options.instructions,
			},
			context.signal,
		);
		if (outcome.ok === false) {
			return {
				kind: "result",
				result: errorResult(
					`Member delivery failed: ${outcome.code}`,
					target,
					outcome.code,
					"pi-bebop member message",
				),
				format: options.format,
				full: false,
			};
		}
		// Accepted-delivery acknowledgement: identity, deliveryId, disposition.
		return {
			kind: "result",
			result: {
				ok: true,
				target,
				status: "accepted",
				response: `${outcome.result.member.name} (${outcome.result.member.role}) — ${outcome.result.disposition} — delivery ${outcome.result.deliveryId}`,
				data: {
					member: outcome.result.member,
					deliveryId: outcome.result.deliveryId,
					disposition: outcome.result.disposition,
				},
			},
			format: options.format,
			full: false,
		};
	}
	// Source-selection input errors are usage-class (exit 2) with their stable code.
	return {
		kind: "result",
		result: usageResult(source.message, source.code),
		format: options.format,
		full: false,
	};
}

/** strict:false project — explicit guard instead of discriminant narrowing. */
function isSourceFailure(source: SourceResolution): source is Extract<SourceResolution, { ok: false }> {
	return !source.ok;
}
