import { Command } from "commander";
import {
	BebopClientError,
	createBebopClient,
	type BebopClient,
	type MemberLastMessageResult,
} from "../../sdk/index.ts";
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
const LAST_MESSAGE_DEADLINE_MS = 5_000;

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
		session: string,
	) => Promise<MemberLastMessageOutcome>;
	readonly environmentSession: (environment?: NodeJS.ProcessEnv) => string | undefined;
}

export async function lastMessageThroughSdk(
	session: string,
	target: string,
	signal: AbortSignal,
	client: BebopClient = createBebopClient(),
	deadlineMs = LAST_MESSAGE_DEADLINE_MS,
): Promise<MemberLastMessageOutcome> {
	if (signal.aborted) return { ok: false, code: "aborted" };
	const controller = new AbortController();
	const startedAt = Date.now();
	let deadlineExpired = false;
	const timer = setTimeout(() => {
		deadlineExpired = true;
		controller.abort();
	}, deadlineMs);
	const forwardAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", forwardAbort, { once: true });
	const options = () => ({
		signal: controller.signal,
		timeoutMs: Math.max(50, deadlineMs - (Date.now() - startedAt)),
	});
	try {
		const source = await client.selectSource({ session }, options());
		return { ok: true, result: await source.getMemberLastMessage(target, options()) };
	} catch (error) {
		if (deadlineExpired) return { ok: false, code: "timeout" };
		if (error instanceof BebopClientError) return { ok: false, code: error.code };
		return { ok: false, code: "transport-error" };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", forwardAbort);
	}
}

export const defaultMemberLastMessageCliDependencies: MemberLastMessageCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	sendLastMessage: async (_source, target, signal, session) => lastMessageThroughSdk(session, target, signal),
	environmentSession: (environment = process.env) => environment.PI_SESSION_ID,
};

export async function runMemberLastMessageCommand(
	options: MemberLastMessageCliOptions,
	context: CliContext,
	deps: MemberLastMessageCliDependencies = defaultMemberLastMessageCliDependencies,
): Promise<CliOutcome> {
	const environmentSession = deps.environmentSession(context.environment);
	const source = deps.resolveSource({ explicitSession: options.session, environmentSession });
	if (source.ok === false) throw new UsageError(source.message);
	const session = options.session !== undefined && options.session !== "" ? options.session : environmentSession;
	const outcome = await deps.sendLastMessage(source, options.member, context.signal, session ?? "");
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
					: `${member.name} (${member.role}) — ${message.content}`,
			data: outcome.result,
		},
		format: options.format,
		full: false,
	};
}
