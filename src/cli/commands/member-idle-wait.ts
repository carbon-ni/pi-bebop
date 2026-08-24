import { Command, CommanderError } from "commander";
import { formatMemberIdleWaitResult, isMemberIdleWaitResult } from "../../domain/index.ts";
import { sendMemberIdleWait, type MemberIdleWaitClientOutcome } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { parsePositiveDurationMs } from "../parser.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
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
	const tokens: string[] = [];
	let help = false;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const raw = args[index]!;
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (flag === "--session" || flag === "--timeout" || flag === "--format") {
			if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
			seen.add(flag);
			if (equals > 0) tokens.push(raw);
			else tokens.push(raw);
			continue;
		}
		tokens.push(raw);
	}
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

export interface MemberIdleWaitCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly sendWait: (
		source: SourceResolution & { ok: true },
		target: string,
		timeoutSeconds: number,
		signal: AbortSignal,
	) => Promise<MemberIdleWaitClientOutcome>;
	readonly environmentSession: () => string | undefined;
}

async function waitThroughSocket(
	socketPath: string,
	target: string,
	timeoutSeconds: number,
	signal: AbortSignal,
): Promise<MemberIdleWaitClientOutcome> {
	const resolved = await resolveMemberEndpoint(socketPath);
	return sendMemberIdleWait(resolved, { type: "member_idle_wait", member: target }, { timeoutSeconds, signal });
}

export const defaultMemberIdleWaitCliDependencies: MemberIdleWaitCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	sendWait: async (source, target, timeoutSeconds, signal) => {
		const primary = await waitThroughSocket(source.idSocketPath, target, timeoutSeconds, signal);
		if (primary.ok || !("code" in primary) || primary.code !== "transport-error") return primary;
		// A value may be an alias symlink; retry once through the alias candidate.
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
	const outcome = await deps.sendWait(source, options.member, options.timeoutSeconds, context.signal);
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
