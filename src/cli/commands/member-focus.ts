import { Command } from "commander";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { isMemberFocusResult, MAX_MEMBER_FOCUS_BYTES, type MemberFocusResult } from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { errorResult, usageResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { resolveSourceSession, SESSION_LIST_HINT, type SourceResolution } from "../source-session.ts";
import { readStdinMessage } from "../message-input.ts";

export type MemberFocusAction = "set" | "clear";
export interface MemberFocusCliOptions {
	readonly command: "member-focus-set" | "member-focus-clear";
	readonly action: MemberFocusAction;
	readonly session?: string;
	readonly focus?: string;
	readonly stdin: boolean;
	readonly format: CliFormat;
	readonly help?: boolean;
}

function validFormat(value: string): value is CliFormat {
	return value === "toon" || value === "json" || value === "text";
}
function validateFocus(value: string): void {
	if (value.length === 0 || value.trim().length === 0 || value !== value.trim())
		throw new UsageError("Focus must be nonblank and must not have leading or trailing whitespace");
	if (/[\0\r\n]/u.test(value)) throw new UsageError("Focus must be a single line without NUL bytes");
	if (Buffer.byteLength(value, "utf8") > MAX_MEMBER_FOCUS_BYTES)
		throw new UsageError(`Focus exceeds the ${MAX_MEMBER_FOCUS_BYTES}-byte limit`);
}

export function buildMemberFocusCommand(action: MemberFocusAction): Command {
	return new Command(action)
		.description(
			action === "set" ? "Publish or replace your own crew-visible Focus" : "Clear your own crew-visible Focus",
		)
		.option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.option("--stdin", "Read Focus from stdin (set only)")
		.argument(action === "set" ? "[<text>]" : "[<unexpected>]")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function memberFocusHelp(action: MemberFocusAction): string {
	const syntax =
		action === "set"
			? "pi-bebop member focus set [--session <id|alias>] [--] <text>"
			: "pi-bebop member focus clear [--session <id|alias>]";
	return [
		syntax,
		"",
		action === "set"
			? "Publish or replace your own short, single-line crew-visible Focus."
			: "Clear your own crew-visible Focus.",
		"Focus is self-reported and unverified; it is not task progress, activity, completion, or a secret store.",
		"Focus changes only the selected joined source session's local durable state and never target another member.",
		...(action === "set" ? ["Use -- before text that starts with '-' (for example: -- --blocked)."] : []),
		"",
		"Options:",
		"  --session <id|alias>    Source joined Pi session id or alias (default: PI_SESSION_ID)",
		...(action === "set" ? ["  --stdin                 Read Focus from stdin"] : []),
		"  --format <format>       toon (default), json, or text",
		"",
		`Discover sessions with: ${SESSION_LIST_HINT}`,
		"",
	].join("\n");
}

export function parseMemberFocusCommand(
	args: string[],
	action: MemberFocusAction,
	_cwd = process.cwd(),
): MemberFocusCliOptions {
	let session: string | undefined;
	let format: CliFormat = "toon";
	let stdin = false;
	let help = false;
	let afterTerminator = false;
	let focus: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]!;
		if (!afterTerminator && token === "--") {
			afterTerminator = true;
			continue;
		}
		if (!afterTerminator && token === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (!afterTerminator && token === "--session") {
			if (session !== undefined) throw new UsageError("Duplicate flag: --session");
			session = args[++index];
			if (session === undefined || session.startsWith("--")) throw new UsageError("Missing value for --session");
			continue;
		}
		if (!afterTerminator && token === "--format") {
			const value = args[++index];
			if (value === undefined) throw new UsageError("Missing value for --format");
			if (!validFormat(value))
				throw new UsageError(`Invalid --format '${value}'; valid alternatives: toon, json, text`);
			format = value;
			continue;
		}
		if (!afterTerminator && token === "--stdin") {
			if (action === "clear") throw new UsageError("--stdin is valid only for member focus set");
			if (stdin) throw new UsageError("Duplicate flag: --stdin");
			stdin = true;
			continue;
		}
		if (!afterTerminator && token.startsWith("-"))
			throw new UsageError("Focus text beginning with '-' requires the '--' terminator");
		if (focus !== undefined) throw new UsageError("Focus text must be one argument");
		focus = token;
	}
	if (action === "clear" && focus !== undefined) throw new UsageError("member focus clear does not accept text");
	if (!help && action === "set" && !stdin && focus === undefined)
		throw new UsageError("Missing Focus text; provide [--] <text> or --stdin");
	if (!help && action === "set" && stdin && focus !== undefined)
		throw new UsageError("Choose exactly one Focus source: [--] <text> or --stdin");
	if (!help && action === "set" && focus !== undefined) validateFocus(focus);
	return {
		command: action === "set" ? "member-focus-set" : "member-focus-clear",
		action,
		...(session === undefined ? {} : { session }),
		...(focus === undefined ? {} : { focus }),
		stdin,
		format,
		...(help ? { help: true } : {}),
	};
}

interface FocusCommand {
	readonly type: "member_focus";
	readonly action: MemberFocusAction;
	readonly focus?: string;
}
export interface MemberFocusCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly readStdin: typeof readStdinMessage;
	readonly deliverFocus: (
		source: SourceResolution & { ok: true },
		command: FocusCommand,
		signal: AbortSignal,
	) => Promise<{ ok: true; result: MemberFocusResult } | { ok: false; code: string }>;
	readonly environmentSession: () => string | undefined;
}

export function mapMemberFocusTransportError(error: unknown): { ok: false; code: string } {
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
	if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
	if (error instanceof Error && /timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	return { ok: false, code: "transport-error" };
}

async function deliverFocus(source: SourceResolution & { ok: true }, command: FocusCommand, signal: AbortSignal) {
	try {
		const { response } = await sendRpcCommand(source.idSocketPath, command, { timeout: 5000, signal });
		if (!response.success) return { ok: false as const, code: response.error ?? "remote-rejected" };
		if (!isMemberFocusResult(response.data)) return { ok: false as const, code: "malformed-response" };
		return { ok: true as const, result: response.data };
	} catch (error) {
		if (error instanceof RpcProtocolError && error.code === "remote-error")
			return { ok: false as const, code: error.message.replace(/^remote-error:\s*/, "") };
		return mapMemberFocusTransportError(error);
	}
}
export const defaultMemberFocusCliDependencies: MemberFocusCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	readStdin: readStdinMessage,
	deliverFocus,
	environmentSession: () => process.env.PI_SESSION_ID,
};

export async function runMemberFocusCommand(
	options: MemberFocusCliOptions,
	context: CliContext,
	deps: MemberFocusCliDependencies = defaultMemberFocusCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: memberFocusHelp(options.action) };
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
	let focus = options.focus;
	if (options.stdin) {
		focus = await deps.readStdin(context.input, context.signal);
		validateFocus(focus);
	}
	const outcome = await deps.deliverFocus(
		source,
		{ type: "member_focus", action: options.action, ...(focus === undefined ? {} : { focus }) },
		context.signal,
	);
	if (outcome.ok === false)
		return {
			kind: "result",
			result: errorResult(`Focus update failed: ${outcome.code}`, "focus", outcome.code),
			format: options.format,
			full: false,
		};
	const wording =
		outcome.result.status === "unchanged" ? "Focus already clear (unchanged)" : `Focus ${outcome.result.status}`;
	return {
		kind: "result",
		result: { ok: true, target: "focus", status: outcome.result.status, response: wording, data: outcome.result },
		format: options.format,
		full: false,
	};
}
