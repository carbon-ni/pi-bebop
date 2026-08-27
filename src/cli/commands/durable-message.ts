import { Command, CommanderError } from "commander";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import {
	isCrewBroadcastResult,
	isMemberInboxSendResult,
	type CrewBroadcastRpcResult,
	type MemberInboxSendResult,
} from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { parseFlagTokens } from "../flags.ts";
import { errorResult, usageResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";
import { readStdinMessage } from "../message-input.ts";

export type DurableMessageIntent = "inbox" | "broadcast";
export interface DurableMessageCliOptions {
	readonly command: "member-inbox-send" | "crew-broadcast";
	readonly intent: DurableMessageIntent;
	readonly member?: string;
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

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}
function label(intent: DurableMessageIntent): string {
	return intent === "inbox" ? "Inbox" : "Broadcast";
}
function commandWords(intent: DurableMessageIntent): readonly string[] {
	return intent === "inbox" ? ["member", "inbox", "send"] : ["crew", "broadcast"];
}

export function buildDurableMessageCommand(intent: DurableMessageIntent): Command {
	const words = commandWords(intent);
	const command = words[words.length - 1]!;
	let program = new Command(command)
		.description(
			intent === "inbox"
				? "Persist one durable Inbox item for a crew member (persisted-only)"
				: "Persist one durable Inbox copy for every other crew member (persisted-only)",
		)
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option("--message <text>", "Message text")
		.option("--stdin", "Read message from stdin")
		.option("--instruction <value>", "Instruction (repeatable, ordered)", collect, [])
		.option("--format <format>", "Output format: toon (default), json, or text", "toon");
	if (intent === "inbox") program = program.argument("[<member>]");
	return program.showHelpAfterError(false).helpOption(false);
}
function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

export function durableMessageHelp(intent: DurableMessageIntent): string {
	const command = intent === "inbox" ? "member inbox send <member>" : "crew broadcast";
	const target = intent === "inbox" ? "one configured member" : "every other configured member in manifest order";
	return (
		[
			`pi-bebop ${command} [--session <id|alias>] (--message <text> | --stdin) [--instruction <text>...] [--format toon|json|text]`,
			"",
			`${label(intent)} persists durable Inbox data for ${target}.`,
			"The selected joined source derives membership, trust, origin, manifest, and storage paths.",
			"The CLI never accepts caller-supplied source identity, manifest, socket, or reply fields.",
			"",
			intent === "inbox"
				? "Success means persisted (and an optional best-effort hint), never read, delivered, or completed."
				: "Success means persisted copies, never delivered, read, or completed; retries reuse deterministic ids.",
			"There is no wait_for flag: persistence acknowledgement is the only guarantee.",
			intent === "broadcast"
				? "The broadcast id already contains a different payload (idempotency-conflict); change the message or instructions and retry."
				: "",
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
		]
			.filter((line) => line !== "")
			.join("\n") + "\n"
	);
}

const VALID_FLAGS =
	"--session <id|alias>, --message <text>, --stdin, --instruction <text>, --format toon|json|text, --help";
function mapCommanderError(error: CommanderError): UsageError {
	if (error.code === "commander.optionMissingArgument") return new UsageError("Missing option value");
	if (error.code === "commander.unknownOption") {
		const unknown = /unknown option '([^']+)'/.exec(error.message)?.[1] ?? "";
		if (unknown.startsWith("--wait"))
			return new UsageError(
				`Unknown flag '${unknown}'; this command is persisted-only and never waits for delivery`,
			);
		return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS}`);
	}
	if (error.code === "commander.excessArguments")
		return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS}`);
	return new UsageError(error.message);
}
function validateContent(message: string, source: string): void {
	if (message.length === 0 || message.trim().length === 0) throw new UsageError(`--${source} received empty content`);
	if (message.includes("\0")) throw new UsageError(`--${source} must not contain NUL bytes`);
	if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES)
		throw new UsageError(`--${source} exceeds the ${MAX_MESSAGE_BYTES}-byte message limit`);
}
function validateInstructions(instructions: readonly string[]): void {
	if (instructions.length > 32) throw new UsageError("Too many --instruction values; maximum is 32");
	for (const instruction of instructions) {
		if (instruction.length === 0 || instruction !== instruction.trim())
			throw new UsageError("Each --instruction must be trimmed and non-empty");
		if (instruction.includes("\0")) throw new UsageError("--instruction must not contain NUL bytes");
		if (Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES)
			throw new UsageError(`--instruction exceeds the ${MAX_INSTRUCTION_BYTES}-byte limit`);
	}
}

type DurableMessageRawOptions = { session?: string; message?: string; stdin?: boolean; format?: string };

function parseDurableMessageTokens(
	tokens: readonly string[],
	intent: DurableMessageIntent,
): {
	opts: DurableMessageRawOptions;
	member?: string;
} {
	const program = buildDurableMessageCommand(intent)
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	try {
		program.parse(tokens, { from: "user" });
		return { opts: program.opts(), ...(intent === "inbox" ? { member: program.args[0] ?? "" } : {}) };
	} catch (error) {
		if (error instanceof CommanderError) throw mapCommanderError(error);
		throw error;
	}
}

function validateDurableMessageOptions(
	opts: DurableMessageRawOptions,
	intent: DurableMessageIntent,
	member: string | undefined,
	help: boolean,
	instructions: readonly string[],
): { format: CliFormat; hasMessage: boolean; hasStdin: boolean } {
	const format = (opts.format ?? "toon") as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	validateInstructions(instructions);
	if (!help && intent === "inbox" && (!member || member.trim().length === 0))
		throw new UsageError("Missing <member>");
	if (
		!help &&
		intent === "inbox" &&
		(member !== member!.trim() || Buffer.byteLength(member!, "utf8") > MAX_TARGET_BYTES)
	)
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
	const hasMessage = opts.message !== undefined;
	const hasStdin = opts.stdin === true;
	if (!help) validateDurableMessageSource(opts.message, hasMessage, hasStdin);
	return { format: format as CliFormat, hasMessage, hasStdin };
}

function validateDurableMessageSource(message: string | undefined, hasMessage: boolean, hasStdin: boolean): void {
	if (hasMessage === hasStdin) throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
	if (hasMessage) validateContent(message!, "message");
}

export function parseDurableMessageCommand(
	args: string[],
	intent: DurableMessageIntent,
	_cwd = process.cwd(),
): DurableMessageCliOptions {
	const parsed = parseFlagTokens(args, {
		valueFlags: new Set(["--session", "--message", "--format"]),
		booleanFlags: new Set(["--stdin"]),
		repeatableFlags: new Set(["--instruction"]),
		rejectFlagLikeValues: true,
	});
	const instructions = parsed.repeatableValues.get("--instruction") ?? [];
	const { opts, member } = parseDurableMessageTokens(parsed.tokens, intent);
	const validated = validateDurableMessageOptions(opts, intent, member, parsed.help, instructions);
	return {
		command: intent === "inbox" ? "member-inbox-send" : "crew-broadcast",
		intent,
		...(member === undefined ? {} : { member: member.trim() }),
		...(opts.session === undefined ? {} : { session: opts.session }),
		...(validated.hasMessage ? { message: opts.message } : {}),
		instructions,
		stdin: validated.hasStdin,
		format: validated.format,
		...(parsed.help ? { help: true } : {}),
	};
}

export type DurableMessageCommand =
	| {
			readonly type: "member_inbox_send";
			readonly target: string;
			readonly message: string;
			readonly instructions?: string[];
	  }
	| {
			readonly type: "crew_broadcast";
			readonly message: string;
			readonly instructions?: string[];
	  };
export interface DurableMessageCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly readStdin: typeof readStdinMessage;
	readonly deliver: (
		source: SourceResolution & { ok: true },
		command: DurableMessageCommand,
		signal: AbortSignal,
	) => Promise<{ ok: true; result: MemberInboxSendResult | CrewBroadcastRpcResult } | { ok: false; code: string }>;
	readonly environmentSession: () => string | undefined;
}
const REMOTE_DURABLE_CODES = new Set([
	"not-joined",
	"unknown-sender",
	"unknown-member",
	"ambiguous-role",
	"self-send",
	"invalid-payload",
	"untrusted-project",
	"inbox-full",
	"inbox-untrusted-path",
	"storage-unavailable",
	"storage-failed",
	"invalid-item-id",
	"aborted",
	"idempotency-conflict",
	"no-recipients",
]);
function transportError(error: unknown): { ok: false; code: string } {
	if (error instanceof RpcProtocolError && (error.code === "outcome-unknown" || REMOTE_DURABLE_CODES.has(error.code)))
		return { ok: false, code: error.code };
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
	if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
	if (error instanceof Error && /timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	return { ok: false, code: "transport-error" };
}
async function deliverSocket(
	source: SourceResolution & { ok: true },
	command: DurableMessageCommand,
	signal: AbortSignal,
) {
	const { response } = await sendRpcCommand(
		await resolveMemberEndpoint(source.idSocketPath),
		{ ...command, ...(command.instructions === undefined ? {} : { instructions: [...command.instructions] }) },
		{ timeout: 5000, signal, classifyLostAck: true },
	);
	if (!response.success) return { ok: false as const, code: response.error ?? "remote-rejected" };
	if (command.type === "member_inbox_send" && isMemberInboxSendResult(response.data))
		return { ok: true as const, result: response.data };
	if (command.type === "crew_broadcast" && isCrewBroadcastResult(response.data))
		return { ok: true as const, result: response.data };
	return { ok: false as const, code: "malformed-response" };
}
export const defaultDurableMessageCliDependencies: DurableMessageCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	readStdin: readStdinMessage,
	deliver: async (source, command, signal) => {
		try {
			return await deliverSocket(source, command, signal);
		} catch (error) {
			const mapped = transportError(error);
			if (mapped.code !== "unknown-session" || source.aliasSocketPath === source.idSocketPath) return mapped;
			try {
				return await deliverSocket({ ...source, idSocketPath: source.aliasSocketPath }, command, signal);
			} catch (aliasError) {
				return transportError(aliasError);
			}
		}
	},
	environmentSession: () => process.env.PI_SESSION_ID,
};

function inboxOutcome(result: MemberInboxSendResult, member: string | undefined, format: CliFormat): CliOutcome {
	return {
		kind: "result",
		result: {
			ok: true,
			target: member ?? "member",
			status: "persisted",
			response: `${result.member.name} (${result.member.role}) — persisted ${result.itemId}`,
			data: result,
		},
		format,
		full: false,
	};
}

function broadcastOutcome(result: CrewBroadcastRpcResult, format: CliFormat): CliOutcome {
	const partial = result.summary.failed > 0;
	const conflict = result.dispositions.some(
		(disposition) => disposition.disposition === "failed" && disposition.code === "idempotency-conflict",
	);
	return {
		kind: "result",
		result: {
			ok: !partial,
			target: "crew",
			status: partial ? "partial" : "persisted",
			response: `${result.summary.persisted} persisted, ${result.summary.alreadyPersisted} already persisted, ${result.summary.failed} failed`,
			data: result,
			...(partial
				? {
						error: {
							code: conflict ? "idempotency-conflict" : "partial",
							message: conflict
								? "Broadcast stopped after an idempotency conflict; no later recipients were written"
								: "Broadcast partially persisted; retry is safe and will not duplicate",
						},
					}
				: {}),
		},
		format,
		full: false,
	};
}

export async function runDurableMessageCommand(
	options: DurableMessageCliOptions,
	context: CliContext,
	deps = defaultDurableMessageCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: durableMessageHelp(options.intent) };
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(),
	});
	if (source.ok === false)
		return {
			kind: "result",
			result: usageResult(source.message, source.code),
			format: options.format,
			full: false,
		};
	let message = options.message;
	if (options.stdin) {
		message = await deps.readStdin(context.input, context.signal);
		validateContent(message, "stdin");
	}
	const instructions = options.instructions.length === 0 ? undefined : options.instructions;
	const command: DurableMessageCommand =
		options.intent === "inbox"
			? {
					type: "member_inbox_send",
					target: options.member!,
					message: message!,
					...(instructions === undefined ? {} : { instructions }),
				}
			: { type: "crew_broadcast", message: message!, ...(instructions === undefined ? {} : { instructions }) };
	const outcome = await deps.deliver(source, command, context.signal);
	if (outcome.ok === false)
		return {
			kind: "result",
			result: errorResult(`Durable message failed: ${outcome.code}`, options.member ?? "crew", outcome.code),
			format: options.format,
			full: false,
		};
	return options.intent === "inbox"
		? inboxOutcome(outcome.result as MemberInboxSendResult, options.member, options.format)
		: broadcastOutcome(outcome.result as CrewBroadcastRpcResult, options.format);
}
