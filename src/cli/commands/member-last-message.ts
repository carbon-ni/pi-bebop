import { Command } from "commander";
import { isMemberLastMessageResult, type MemberLastMessageResult } from "../../domain/index.ts";
import { RpcProtocolError, sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import type { CliContext } from "../support/context.ts";
import { errorResult } from "../support/errors.ts";
import type { CliOutcome } from "../support/output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../support/source-session.ts";

export interface MemberLastMessageCliOptions {
	readonly command: "member-last-message";
	readonly member: string;
	readonly session?: string;
	readonly format: CliFormat;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];
const MAX_TARGET_BYTES = 256;

function escapeTerminalControls(value: string): string {
	return Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
			? `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`
			: character;
	}).join("");
}

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export function buildMemberLastMessageCommand(): Command {
	return new Command("last-message")
		.description("Inspect one crew member's latest assistant text (read-only snapshot)")
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option(
			"--format <format>",
			"Output format: text (default), toon, or json",
			defaultFormatForCommand("member-last-message"),
		)
		.argument("[<member>]", "Crew member name or unique role")
		.addHelpText(
			"after",
			[
				"",
				"Returns only the latest recorded assistant text on the target's active branch.",
				"It excludes user, system, reasoning, and tool content. This is a read-only snapshot:",
				"it never wakes, sends, steers, interrupts, or starts the target.",
				"An online target with no assistant text returns message: null.",
				"",
				`Discover sessions with: ${SESSION_LIST_HINT}`,
			].join("\n"),
		);
}

export function readMemberLastMessageCommand(parsed: Command): MemberLastMessageCliOptions {
	const opts = parsed.opts<{ session?: string; format?: string }>();
	const format = (opts.format ?? defaultFormatForCommand("member-last-message")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	const member = parsed.args[0] ?? "";
	if (member.trim().length === 0) throw new UsageError("Missing <member>; provide a crew member name or unique role");
	if (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES)
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
	return {
		command: "member-last-message",
		member: member.trim(),
		...(opts.session === undefined ? {} : { session: opts.session }),
		format,
	};
}

export type MemberLastMessageOutcome = { ok: true; result: MemberLastMessageResult } | { ok: false; code: string };

export interface MemberLastMessageCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly sendLastMessage: (
		source: SourceResolution & { ok: true },
		target: string,
		signal: AbortSignal,
	) => Promise<MemberLastMessageOutcome>;
	readonly environmentSession: (environment?: NodeJS.ProcessEnv) => string | undefined;
}

async function lastMessageThroughSocket(
	socketPath: string,
	target: string,
	signal: AbortSignal,
): Promise<MemberLastMessageOutcome> {
	const resolved = await resolveMemberEndpoint(socketPath);
	try {
		const { response } = await sendRpcCommand(
			resolved,
			{ type: "member_last_message_target", target },
			{ timeout: 5000, signal },
		);
		if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
		if (!isMemberLastMessageResult(response.data)) return { ok: false, code: "malformed-response" };
		return { ok: true, result: response.data };
	} catch (error) {
		if (error instanceof RpcProtocolError && error.code === "remote-error")
			return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
		if (
			error instanceof RpcProtocolError &&
			["invalid-result", "malformed-response", "mismatched-id"].includes(error.code)
		)
			return { ok: false, code: "malformed-response" };
		if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
			return { ok: false, code: "aborted" };
		const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") return { ok: false, code: "unknown-session" };
		if (code === "ECONNREFUSED" || code === "ENOTCONN" || code === "ENOTSOCK")
			return { ok: false, code: "offline-session" };
		if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
		return { ok: false, code: "transport-error" };
	}
}

export const defaultMemberLastMessageCliDependencies: MemberLastMessageCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	sendLastMessage: async (source, target, signal) => {
		const first = await lastMessageThroughSocket(source.idSocketPath, target, signal);
		if (first.ok === false && first.code === "unknown-session")
			return lastMessageThroughSocket(source.aliasSocketPath, target, signal);
		return first;
	},
	environmentSession: (environment = process.env) => environment.PI_SESSION_ID,
};

export async function runMemberLastMessageCommand(
	options: MemberLastMessageCliOptions,
	context: CliContext,
	deps: MemberLastMessageCliDependencies = defaultMemberLastMessageCliDependencies,
): Promise<CliOutcome> {
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(context.environment),
	});
	if (source.ok === false) throw new UsageError(source.message);
	const outcome = await deps.sendLastMessage(source, options.member, context.signal);
	if (outcome.ok === false)
		return {
			kind: "result",
			result: errorResult(`Last message failed: ${outcome.code}`, options.member, outcome.code),
			format: options.format,
			full: false,
		};
	const { member, message } = outcome.result;
	return {
		kind: "result",
		result: {
			ok: true,
			target: options.member,
			status: message === null ? "empty" : "observed",
			response:
				message === null
					? `${member.name} (${member.role}) — no assistant message recorded`
					: `${member.name} (${member.role}) — ${escapeTerminalControls(message.content)}`,
			data: outcome.result,
		},
		format: options.format,
		full: false,
	};
}
