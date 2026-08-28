import { Command } from "commander";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { isMemberInterruptResult, type MemberInterruptResult } from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { errorResult, usageResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";
import { readStdinMessage } from "../message-input.ts";
import { parseMemberMessageCommand } from "./member-message.ts";

export interface MemberInterruptCliOptions {
	readonly command: "member-interrupt";
	readonly member: string;
	readonly session?: string;
	readonly message?: string;
	readonly instructions: string[];
	readonly stdin: boolean;
	readonly format: CliFormat;
	readonly help?: boolean;
}

export function buildMemberInterruptCommand(): Command {
	return new Command("interrupt")
		.description("Hard-interrupt stuck or harmful work and deliver recovery guidance (best-effort, no rollback)")
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option("--message <text>", "Recovery guidance message")
		.option("--stdin", "Read recovery guidance from stdin")
		.option("--instruction <value>", "Instruction (repeatable, ordered)", collect, [])
		.option("--format <format>", "Output format: text (default), json, or toon", "text")
		.argument("[<member>]", "Crew member name or unique role")
		.showHelpAfterError(false)
		.helpOption(false);
}
function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

export function memberInterruptHelp(): string {
	return [
		"pi-bebop member interrupt <member> [--session <id|alias>] (--message <text> | --stdin) [--instruction <text>...] [--format toon|json|text]",
		"",
		"Hard-interrupt a joined crew member only when work is stuck, harmful, or based on invalid assumptions.",
		"The target owns recovery evidence ordering. Abort is best-effort: it cannot roll back completed effects,",
		"non-cooperative work, filesystem changes, network effects, or claim target completion.",
		"An accepted result means recovery was handed off with a disposition; it never means work was undone or done.",
		"",
		"Options:",
		"  --session <id|alias>    Source joined Pi session id or alias (default: PI_SESSION_ID)",
		"  --message <text>        Recovery guidance (exactly one of --message or --stdin)",
		"  --stdin                 Read recovery guidance from stdin",
		"  --instruction <text>    Ordered instruction (repeatable, at most 32)",
		"  --format <format>       text (default), json, or toon",
		"",
		`Discover sessions with: ${SESSION_LIST_HINT}`,
		"",
	].join("\n");
}

export function parseMemberInterruptCommand(args: string[], cwd = process.cwd()): MemberInterruptCliOptions {
	const parsed = parseMemberMessageCommand(args, "follow_up", cwd, "text");
	return {
		command: "member-interrupt",
		member: parsed.member,
		...(parsed.session === undefined ? {} : { session: parsed.session }),
		...(parsed.message === undefined ? {} : { message: parsed.message }),
		instructions: parsed.instructions,
		stdin: parsed.stdin,
		format: parsed.format,
		...(parsed.help ? { help: true } : {}),
	};
}

interface InterruptCommand {
	readonly type: "member_interrupt";
	readonly target: string;
	readonly message: string;
	readonly instructions?: string[];
}

export interface MemberInterruptCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly readStdin: typeof readStdinMessage;
	readonly deliverInterrupt: (
		source: SourceResolution & { ok: true },
		command: InterruptCommand,
		signal: AbortSignal,
	) => Promise<{ ok: true; result: MemberInterruptResult } | { ok: false; code: string }>;
	readonly environmentSession: () => string | undefined;
}

export function mapInterruptTransportError(error: unknown): { ok: false; code: string } {
	if (error instanceof RpcProtocolError && error.code === "remote-error")
		return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
	if (error instanceof RpcProtocolError && error.code === "outcome-unknown")
		return { ok: false, code: "outcome-unknown" };
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	if (error instanceof Error && /timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return { ok: false, code: "unknown-session" };
	if (code === "ECONNREFUSED" || code === "ENOTCONN") return { ok: false, code: "offline-session" };
	return { ok: false, code: "transport-error" };
}

async function deliverThroughSocket(
	source: SourceResolution & { ok: true },
	command: InterruptCommand,
	signal: AbortSignal,
): Promise<{ ok: true; result: MemberInterruptResult } | { ok: false; code: string }> {
	const endpoint = await resolveMemberEndpoint(source.idSocketPath);
	try {
		const { response } = await sendRpcCommand(endpoint, command, { timeout: 5000, signal, classifyLostAck: true });
		if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
		if (!isMemberInterruptResult(response.data)) return { ok: false, code: "invalid-ack" };
		return { ok: true, result: response.data };
	} catch (error) {
		return mapInterruptTransportError(error);
	}
}

export const defaultMemberInterruptCliDependencies: MemberInterruptCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	readStdin: readStdinMessage,
	deliverInterrupt: deliverThroughSocket,
	environmentSession: () => process.env.PI_SESSION_ID,
};

export async function runMemberInterruptCommand(
	options: MemberInterruptCliOptions,
	context: CliContext,
	deps: MemberInterruptCliDependencies = defaultMemberInterruptCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: memberInterruptHelp() };
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
		if (message.trim().length === 0)
			throw new UsageError("--stdin received empty content; provide UTF-8 recovery guidance");
	}
	if (message === undefined) throw new UsageError("Missing message source; use --message <text> or --stdin");
	const command: InterruptCommand = {
		type: "member_interrupt",
		target: options.member,
		message,
		...(options.instructions.length === 0 ? {} : { instructions: [...options.instructions] }),
	};
	const outcome = await deps.deliverInterrupt(source, command, context.signal);
	if (outcome.ok === false)
		return {
			kind: "result",
			result: errorResult(
				`Member interrupt failed: ${outcome.code}`,
				options.member,
				outcome.code,
				"pi-bebop member interrupt",
			),
			format: options.format,
			full: false,
		};
	const text =
		outcome.result.disposition === "direct"
			? "idle target; recovery handed off directly"
			: "abort requested best-effort; recovery handed off ahead of queued follow-ups";
	return {
		kind: "result",
		result: {
			ok: true,
			target: options.member,
			status: "accepted",
			response: `${text} (${outcome.result.interruptId})`,
			data: outcome.result,
		},
		format: options.format,
		full: false,
	};
}
