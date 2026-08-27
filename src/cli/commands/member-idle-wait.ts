import { Command, CommanderError } from "commander";
import { formatMemberIdleWaitResult, isMemberIdleWaitResult } from "../../domain/index.ts";
import { sendMemberIdleWait, type MemberIdleWaitClientOutcome } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { parsePositiveDurationMs } from "../parser.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { parseFlagTokens } from "../flags.ts";
import { errorResult, usageResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";

export interface MemberIdleWaitCliOptions {
	readonly command: "member-idle-wait";
	readonly member: string;
	readonly session?: string;
	readonly timeoutSeconds: number;
	readonly format: CliFormat;
	readonly help?: boolean;
}

const MAX_TARGET_BYTES = 256;
const VALID_FLAGS = "--session <id|alias>, --timeout <duration>, --format toon|json|text, --help";

function mapCommanderError(error: CommanderError): UsageError {
	const match = /--[a-z-]+/.exec(error.message);
	const flag = match?.[0] ?? "--timeout";
	if (error.code === "commander.optionMissingArgument") return new UsageError(`Missing value for ${flag}`);
	if (error.code === "commander.unknownOption") {
		const unknown = /unknown option '(--?[^']+)'/.exec(error.message)?.[1] ?? "";
		return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS}`);
	}
	if (error.code === "commander.excessArguments")
		return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS}`);
	return new UsageError(error.message);
}

function parseTimeout(value: string): number {
	let milliseconds: number;
	try {
		milliseconds = parsePositiveDurationMs(value);
	} catch {
		throw new UsageError(`Invalid --timeout '${value}'; use a whole-second duration from 1s through 10m`);
	}
	if (milliseconds % 1000 !== 0 || milliseconds < 1000 || milliseconds > 600_000)
		throw new UsageError(`Invalid --timeout '${value}'; use a whole-second duration from 1s through 10m`);
	return milliseconds / 1000;
}

export function buildMemberIdleWaitCommand(): Command {
	return new Command("wait-idle")
		.description("Wait once for a crew member to become idle or go offline")
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option("--timeout <duration>", "Whole-second wait duration from 1s through 10m", "5m")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.argument("[<member>]", "Crew member name or unique role")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function memberIdleWaitHelp(): string {
	return [
		"pi-bebop member wait-idle <member> [--session <id|alias>] [--timeout <duration>] [--format toon|json|text]",
		"",
		"Wait once for a configured crew member to become idle, go offline, or reach the timeout.",
		"This is event-driven: it never polls, sends a message, or claims task completion.",
		"Already-idle, became-idle, offline, timeout, and aborted outcomes are distinct.",
		"",
		"Options:",
		"  --session <id|alias>   Source joined Pi session id or alias (default: PI_SESSION_ID)",
		"  --timeout <duration>   Whole seconds from 1s through 10m (default: 5m)",
		"  --format <format>      toon (default), json, or text",
		"",
		`Discover sessions with: ${SESSION_LIST_HINT}`,
		"",
	].join("\n");
}

export function parseMemberIdleWaitCommand(args: string[], _cwd = process.cwd()): MemberIdleWaitCliOptions {
	const parsed = parseFlagTokens(args, {
		valueFlags: new Set(["--session", "--timeout", "--format"]),
	});
	const { tokens, help } = parsed;
	const program = buildMemberIdleWaitCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	let opts: { session?: string; timeout?: string; format?: string };
	try {
		program.parse(tokens, { from: "user" });
		opts = program.opts();
	} catch (error) {
		if (error instanceof CommanderError) throw mapCommanderError(error);
		throw error;
	}
	const format = opts.format ?? "toon";
	if (!(["toon", "json", "text"] as string[]).includes(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	const member = program.args[0] ?? "";
	if (!help && member.trim().length === 0)
		throw new UsageError("Missing <member>; provide a crew member name or unique role");
	if (!help && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES))
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
	return {
		command: "member-idle-wait",
		member: member.trim(),
		...(opts.session === undefined ? {} : { session: opts.session }),
		timeoutSeconds: parseTimeout(opts.timeout ?? "5m"),
		format: format as CliFormat,
		...(help ? { help: true } : {}),
	};
}

type MemberIdleWaitCliOutcome =
	| MemberIdleWaitClientOutcome
	| { readonly ok: false; readonly code: "unknown-session" | "offline-session" };

export interface MemberIdleWaitCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly sendWait: (
		source: SourceResolution & { ok: true },
		target: string,
		timeoutSeconds: number,
		signal: AbortSignal,
	) => Promise<MemberIdleWaitCliOutcome>;
	readonly environmentSession: () => string | undefined;
}

export function mapIdleWaitTransportError(error: unknown): MemberIdleWaitCliOutcome {
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return { ok: false, code: "unknown-session" };
	if (code === "ECONNREFUSED" || code === "ENOTCONN") return { ok: false, code: "offline-session" };
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	return { ok: false, code: "transport-error" };
}

export function normalizeIdleWaitTransportOutcome(outcome: MemberIdleWaitClientOutcome): MemberIdleWaitCliOutcome {
	if (outcome.ok || !("transportCode" in outcome)) return outcome;
	if (outcome.transportCode === "ENOENT") return { ok: false, code: "unknown-session" };
	if (outcome.transportCode === "ECONNREFUSED" || outcome.transportCode === "ENOTCONN")
		return { ok: false, code: "offline-session" };
	return outcome;
}

async function waitThroughSocket(
	socketPath: string,
	target: string,
	timeoutSeconds: number,
	signal: AbortSignal,
): Promise<MemberIdleWaitCliOutcome> {
	try {
		const resolved = await resolveMemberEndpoint(socketPath);
		return normalizeIdleWaitTransportOutcome(
			await sendMemberIdleWait(
				resolved,
				{ type: "member_idle_wait", member: target },
				{ timeoutSeconds, signal },
			),
		);
	} catch (error) {
		return mapIdleWaitTransportError(error);
	}
}

export const defaultMemberIdleWaitCliDependencies: MemberIdleWaitCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	sendWait: async (source, target, timeoutSeconds, signal) => {
		const primary = await waitThroughSocket(source.idSocketPath, target, timeoutSeconds, signal);
		if (primary.ok || !("code" in primary) || primary.code !== "unknown-session") return primary;
		// A stale id socket may have a valid alias; retry exactly once.
		return waitThroughSocket(source.aliasSocketPath, target, timeoutSeconds, signal);
	},
	environmentSession: () => process.env.PI_SESSION_ID,
};

export async function runMemberIdleWaitCommand(
	options: MemberIdleWaitCliOptions,
	context: CliContext,
	deps: MemberIdleWaitCliDependencies = defaultMemberIdleWaitCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: memberIdleWaitHelp() };
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(),
	});
	if (!source.ok)
		return {
			kind: "result",
			result: usageResult(
				"message" in source ? source.message : "Unable to resolve source session",
				"code" in source ? source.code : "invalid-session",
			),
			format: options.format,
			full: false,
		};
	let outcome: MemberIdleWaitCliOutcome;
	try {
		outcome = await deps.sendWait(source, options.member, options.timeoutSeconds, context.signal);
	} catch (error) {
		outcome = mapIdleWaitTransportError(error);
	}
	if (!outcome.ok)
		return {
			kind: "result",
			result: errorResult(
				`Member idle wait failed: ${"code" in outcome ? outcome.code : "transport-error"}`,
				options.member,
				"code" in outcome ? outcome.code : "transport-error",
			),
			format: options.format,
			full: false,
		};
	if (!isMemberIdleWaitResult(outcome.result))
		return {
			kind: "result",
			result: errorResult("Member idle wait failed: malformed-response", options.member, "malformed-response"),
			format: options.format,
			full: false,
		};
	return {
		kind: "result",
		result: {
			ok: true,
			target: options.member,
			status: "observed",
			response: formatMemberIdleWaitResult(outcome.result),
			data: { result: outcome.result },
		},
		format: options.format,
		full: false,
	};
}
