import { Command, CommanderError } from "commander";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { isMemberStatusResult, formatMemberStatus, type MemberStatus } from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { errorResult, usageResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";

/**
 * TASK-0061: `member status <member>` leaf — the walking skeleton for the
 * membership CLI. The handler only resolves the source endpoint, submits the
 * delegated status action, maps the result, and renders. All target
 * resolution and privacy validation happen in the source joined session's own
 * member-status flow (never copied into the CLI).
 */

export interface MemberStatusCliOptions {
	readonly command: "member-status";
	readonly member: string;
	/** Raw leaf-command-local `--session` value (session id or alias). */
	readonly session?: string;
	readonly format: CliFormat;
	readonly help?: boolean;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];
const MAX_TARGET_BYTES = 256;

export function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export function buildMemberStatusCommand(): Command {
	return new Command("status")
		.description("Show one crew member's mechanical Pi runtime state and Focus (read-only)")
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.argument("[<member>]", "Crew member name or unique role")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function memberStatusHelp(): string {
	return [
		"pi-bebop member status <member> [--session <id|alias>] [--format toon|json|text]",
		"",
		"Show one crew member's mechanical Pi runtime state (online/offline, idle/busy/compacting,",
		"pending-message signal) and their self-reported Focus note. Read-only: never",
		"starts, steers, or interrupts the target turn. Activity is mechanical and Focus",
		"is member-reported, never verified task progress.",
		"",
		"Options:",
		"  --session <id|alias>   Source joined Pi session id or alias (default: PI_SESSION_ID)",
		"  --format <format>      toon (default), json, or text",
		"",
		"Source: the query runs through one already-joined Pi session, which derives",
		"membership and trust authoritatively. The CLI never loads a crew manifest.",
		"A configured target that is offline is a successful offline result, not an error.",
		"",
		`Discover sessions with: ${SESSION_LIST_HINT}`,
		"",
	].join("\n");
}

const VALID_FLAGS = "--session <id|alias>, --format toon|json|text, --help";

function mapCommanderError(error: CommanderError): UsageError {
	const match = /--[a-z-]+/.exec(error.message);
	const flag = match?.[0] ?? "--format";
	if (error.code === "commander.optionMissingArgument") return new UsageError(`Missing value for ${flag}`);
	if (error.code === "commander.unknownOption") {
		const unknown = /unknown option '(--?[^']+)'/.exec(error.message)?.[1] ?? "";
		return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS}`);
	}
	if (error.code === "commander.excessArguments")
		return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS}`);
	return new UsageError(error.message);
}

/** App-owned parse facade: pre-pass (help/duplicates/sentinel), Commander tokenization, then validation. */
export function parseMemberStatusCommand(args: string[], _cwd = process.cwd()): MemberStatusCliOptions {
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
		if (flag === "--session" || flag === "--format") {
			if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
			seen.add(flag);
			if (equals > 0) {
				tokens.push(raw);
				continue;
			}
			if (args[index + 1] === "--" && args[index + 2] !== undefined) {
				tokens.push(`${flag}=${args[index + 2]}`);
				index += 2;
				continue;
			}
			tokens.push(raw);
			continue;
		}
		tokens.push(raw);
	}

	const program = buildMemberStatusCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	let opts: { session?: string; format?: string };
	try {
		program.parse(tokens, { from: "user" });
		opts = program.opts();
	} catch (error) {
		if (error instanceof CommanderError) throw mapCommanderError(error);
		throw error;
	}
	const format = (opts.format ?? "toon") as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);

	const member = program.args[0] ?? "";
	if (!help && member.trim().length === 0)
		throw new UsageError("Missing <member>; provide a crew member name or unique role");
	if (!help && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES))
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);

	return {
		command: "member-status",
		member: member.trim(),
		...(opts.session === undefined ? {} : { session: opts.session }),
		format: format as CliFormat,
		...(help ? { help: true } : {}),
	};
}

export interface MemberStatusCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly sendStatus: (
		source: SourceResolution & { ok: true },
		target: string,
		signal: AbortSignal,
	) => Promise<MemberStatusOutcome>;
	readonly environmentSession: () => string | undefined;
}

export type MemberStatusOutcome = { ok: true; status: MemberStatus } | { ok: false; code: string };

/** strict:false project — explicit guards instead of discriminant narrowing. */
function isSourceFailure(source: SourceResolution): source is Extract<SourceResolution, { ok: false }> {
	return !source.ok;
}

function isStatusFailure(outcome: MemberStatusOutcome): outcome is { ok: false; code: string } {
	return !outcome.ok;
}

function mapTransportError(error: unknown): { ok: false; code: string } {
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
	if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	return { ok: false, code: "transport-error" };
}

async function statusThroughSocket(
	socketPath: string,
	target: string,
	signal: AbortSignal,
): Promise<{ ok: true; status: MemberStatus } | { ok: false; code: string }> {
	const resolved = await resolveMemberEndpoint(socketPath);
	try {
		const { response } = await sendRpcCommand(
			resolved,
			{ type: "member_status_target", target },
			{ timeout: 5000, signal },
		);
		if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
		if (!isMemberStatusResult(response.data)) return { ok: false, code: "malformed-response" };
		return { ok: true, status: response.data.status };
	} catch (error) {
		// The wire maps server-side rejections to remote-error carrying the stable code.
		if (error instanceof RpcProtocolError && error.code === "remote-error") {
			return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
		}
		throw error;
	}
}

export const defaultMemberStatusCliDependencies: MemberStatusCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	sendStatus: async (source, target, signal) => {
		try {
			return await statusThroughSocket(source.idSocketPath, target, signal);
		} catch (idError) {
			const mapped = mapTransportError(idError);
			if (mapped.code !== "unknown-session") return mapped;
			// The value may be an alias symlink; fall back once, then report unknown-session.
			try {
				return await statusThroughSocket(source.aliasSocketPath, target, signal);
			} catch (aliasError) {
				return mapTransportError(aliasError);
			}
		}
	},
	environmentSession: () => process.env.PI_SESSION_ID,
};

export async function runMemberStatusCommand(
	options: MemberStatusCliOptions,
	context: CliContext,
	deps: MemberStatusCliDependencies = defaultMemberStatusCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: memberStatusHelp() };
	const target = options.member;
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(),
	});
	if (isSourceFailure(source)) {
		// Source-selection input errors are usage-class (exit 2) with their stable code.
		return {
			kind: "result",
			result: usageResult(source.message, source.code),
			format: options.format,
			full: false,
		};
	}
	const outcome = await deps.sendStatus(source, target, context.signal);
	if (isStatusFailure(outcome)) {
		return {
			kind: "result",
			result: errorResult(`Member status failed: ${outcome.code}`, target, outcome.code),
			format: options.format,
			full: false,
		};
	}
	// Observed status is returned untouched; observedAt is never invented or rewritten.
	return {
		kind: "result",
		result: {
			ok: true,
			target,
			status: "observed",
			response: formatMemberStatus(outcome.status),
			data: { status: outcome.status },
		},
		format: options.format,
		full: false,
	};
}
