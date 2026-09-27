import { Command } from "commander";
import { formatMemberStatus, type MemberStatus } from "../../domain/index.ts";
import { BebopClientError, createBebopClient, type BebopClient } from "../../sdk/index.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { errorResult } from "../support/errors.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../support/source-session.ts";

/**
 * TASK-0061: `member status <member>` leaf — the walking skeleton for the
 * membership CLI. The handler validates source selection, delegates through the
 * public SDK status operation, maps the result, and renders. All target
 * resolution and privacy validation happen in the source joined session's own
 * member-status flow (never copied into the CLI).
 */

export interface MemberStatusCliOptions {
	readonly command: "member-status";
	readonly member: string;
	/** Raw leaf-command-local `--session` value (session id or alias). */
	readonly session?: string;
	readonly format: CliFormat;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];
const MAX_TARGET_BYTES = 256;
const STATUS_DEADLINE_MS = 5_000;

export function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export function buildMemberStatusCommand(): Command {
	return new Command("status")
		.description("Show one crew member's mechanical Pi runtime state (read-only)")
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option(
			"--format <format>",
			"Output format: text (default), toon, or json",
			defaultFormatForCommand("member-status"),
		)
		.argument("[<member>]", "Crew member name or unique role")
		.addHelpText(
			"after",
			[
				"",
				"Show one crew member's mechanical Pi runtime state (online/offline, idle/busy/compacting,",
				"pending-message signal) and the observation time. Read-only: never",
				"starts, steers, or interrupts the target turn. Activity is mechanical and",
				"never verified task progress. For intent, progress, a report, or a verdict,",
				"ask explicitly with `bebop member request send`, then `bebop member request wait`.",
				"",
				"Source: the query runs through one already-joined Pi session, which derives",
				"membership and trust authoritatively. The CLI never loads a crew manifest.",
				"A configured target that is offline is a successful offline result, not an error.",
				"",
				`Discover sessions with: ${SESSION_LIST_HINT}`,
			].join("\n"),
		);
}

export function readMemberStatusCommand(parsed: Command): MemberStatusCliOptions {
	const opts = parsed.opts<{ session?: string; format?: string }>();
	const format = (opts.format ?? defaultFormatForCommand("member-status")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	const member = parsed.args[0] ?? "";
	if (member.trim().length === 0) throw new UsageError("Missing <member>; provide a crew member name or unique role");
	if (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES)
		throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
	return {
		command: "member-status",
		member: member.trim(),
		...(opts.session === undefined ? {} : { session: opts.session }),
		format,
	};
}

export interface MemberStatusCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly sendStatus: (
		source: SourceResolution & { ok: true },
		target: string,
		signal: AbortSignal,
		session: string,
	) => Promise<MemberStatusOutcome>;
	readonly environmentSession: (environment?: NodeJS.ProcessEnv) => string | undefined;
}

export type MemberStatusOutcome = { ok: true; status: MemberStatus } | { ok: false; code: string };

/** strict:false project — explicit guards instead of discriminant narrowing. */
function isSourceFailure(source: SourceResolution): source is Extract<SourceResolution, { ok: false }> {
	return !source.ok;
}

function isStatusFailure(outcome: MemberStatusOutcome): outcome is { ok: false; code: string } {
	return !outcome.ok;
}

function mapSdkError(error: unknown): { ok: false; code: string } {
	if (error instanceof BebopClientError) return { ok: false, code: error.code };
	return { ok: false, code: "transport-error" };
}

export async function statusThroughSdk(
	session: string,
	target: string,
	signal: AbortSignal,
	client: BebopClient = createBebopClient(),
): Promise<{ ok: true; status: MemberStatus } | { ok: false; code: string }> {
	if (signal.aborted) return { ok: false, code: "aborted" };
	const controller = new AbortController();
	const startedAt = Date.now();
	let deadlineExpired = false;
	const timer = setTimeout(() => {
		deadlineExpired = true;
		controller.abort();
	}, STATUS_DEADLINE_MS);
	const forwardAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", forwardAbort, { once: true });
	const options = () => ({
		signal: controller.signal,
		timeoutMs: Math.max(50, STATUS_DEADLINE_MS - (Date.now() - startedAt)),
	});
	try {
		const source = await client.selectSource({ session }, options());
		return { ok: true, status: await source.getMemberStatus(target, options()) };
	} catch (error) {
		if (deadlineExpired) return { ok: false, code: "timeout" };
		return mapSdkError(error);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", forwardAbort);
	}
}

export const defaultMemberStatusCliDependencies: MemberStatusCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	sendStatus: (_source, target, signal, session) => statusThroughSdk(session, target, signal),
	environmentSession: (environment = process.env) => environment.PI_SESSION_ID,
};

export async function runMemberStatusCommand(
	options: MemberStatusCliOptions,
	context: CliContext,
	deps: MemberStatusCliDependencies = defaultMemberStatusCliDependencies,
): Promise<CliOutcome> {
	const target = options.member;
	const environmentSession = deps.environmentSession(context.environment);
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession,
	});
	if (isSourceFailure(source)) {
		// Source-selection input errors are usage-class (exit 2) with their stable message.
		throw new UsageError(source.message);
	}
	const session = options.session !== undefined && options.session !== "" ? options.session : environmentSession;
	const outcome = await deps.sendStatus(source, target, context.signal, session ?? "");
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
