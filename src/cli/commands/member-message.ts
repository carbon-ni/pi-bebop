import { Command } from "commander";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { isMemberMessageResult, MAX_MESSAGE_INSTRUCTIONS, type MemberMessageResult } from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { errorResult } from "../support/errors.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../support/source-session.ts";
import { readStdinMessage } from "../support/message-input.ts";

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

export function buildMemberMessageCommand(intent: MemberMessageIntent): Command {
	const word = intentWord(intent);
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
			"Output format: toon (default), json, or text",
			defaultFormatForCommand("member-follow-up"),
		)
		.argument("[<member>]", "Crew member name or unique role")
		.addHelpText(
			"after",
			[
				"",
				`Send a member ${label(intent)} through one already-joined Pi session, which derives`,
				"membership and trust authoritatively. The CLI never loads a crew manifest.",
				"",
				`Delivery: online normal ${label(intent)}; ${intent === "follow_up" ? "waits behind the target's active work" : "enters before the target's next model step"}. Accepted means the message was`,
				"accepted for delivery — it NEVER means replied, delivered work, or completed.",
				"There is no wait_for flag: Pi cannot prove delivery-level response correlation.",
				"",
				`Discover sessions with: ${SESSION_LIST_HINT}`,
			].join("\n"),
		);
}

function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

function label(intent: MemberMessageIntent): string {
	return intent === "follow_up" ? "Follow-up" : "Redirect";
}

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

function validateMemberMessageSource(opts: { message?: string; stdin?: boolean }): {
	hasMessage: boolean;
	hasStdin: boolean;
} {
	const hasMessage = opts.message !== undefined;
	const hasStdin = opts.stdin === true;
	if (hasMessage && hasStdin) throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
	if (!hasMessage && !hasStdin) throw new UsageError("Missing message source; use --message <text> or --stdin");
	if (hasMessage && opts.message!.trim().length === 0) throw new UsageError("--message must not be empty");
	if (hasMessage) validateMessageContent(opts.message!, "message");
	return { hasMessage, hasStdin };
}

function validateMemberMessageOptions(
	member: string,
	opts: { message?: string; stdin?: boolean; format?: string },
	instructions: string[],
): { format: string; hasMessage: boolean; hasStdin: boolean } {
	const format = (opts.format ?? defaultFormatForCommand("member-message")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	validateInstructions(instructions);
	if (member.trim().length === 0) throw new UsageError("Missing <member>; provide a crew member name or unique role");
	if (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES)
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
	const { hasMessage, hasStdin } = validateMemberMessageSource(opts);
	return { format, hasMessage, hasStdin };
}

export function readMemberMessageCommand(command: Command, intent: MemberMessageIntent): MemberMessageCliOptions {
	const opts = command.opts<{
		session?: string;
		message?: string;
		stdin?: boolean;
		instruction?: string[];
		format?: string;
	}>();
	const member = command.args[0] ?? "";
	const instructions = opts.instruction ?? [];
	const { format, hasMessage, hasStdin } = validateMemberMessageOptions(member, opts, instructions);
	return {
		command: intent === "follow_up" ? "member-follow-up" : "member-redirect",
		intent,
		member: member.trim(),
		...(opts.session === undefined ? {} : { session: opts.session }),
		...(hasMessage ? { message: opts.message } : {}),
		instructions,
		stdin: hasStdin,
		format: format as CliFormat,
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
	readonly environmentSession: (environment?: NodeJS.ProcessEnv) => string | undefined;
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
	environmentSession: (environment = process.env) => environment.PI_SESSION_ID,
};

export async function runMemberMessageCommand(
	options: MemberMessageCliOptions,
	context: CliContext,
	deps: MemberMessageCliDependencies = defaultMemberMessageCliDependencies,
): Promise<CliOutcome> {
	const target = options.member;
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(context.environment),
	});
	if (!isSourceFailure(source)) {
		let message = options.message;
		if (options.stdin) {
			try {
				message = await deps.readStdin(context.input, context.signal);
			} catch (error) {
				return {
					kind: "result",
					result: errorResult(
						`Member message failed: ${error instanceof Error ? error.message : String(error)}`,
						target,
						"stdin-error",
					),
					format: options.format,
					full: false,
				};
			}
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
				result: errorResult(`Member delivery failed: ${outcome.code}`, target, outcome.code),
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
	// Source-selection input errors are usage-class (exit 2).
	throw new UsageError(source.message);
}

/** strict:false project — explicit guard instead of discriminant narrowing. */
function isSourceFailure(source: SourceResolution): source is Extract<SourceResolution, { ok: false }> {
	return !source.ok;
}
