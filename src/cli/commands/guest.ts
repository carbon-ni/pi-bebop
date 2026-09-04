import { Command, CommanderError } from "commander";
import { isGuestJoinResult } from "../../domain/index.ts";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { errorCode, errorResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0161: non-interactive Guest wire commands. `guest join` and
 * `guest leave` are stateless RPC surfaces (the interactive `/guest crews`
 * listing stays in-session). Output follows the shared text/TOON/JSON
 * renderer with stable member-side error codes.
 */

export interface GuestJoinCliOptions {
	readonly command: "guest-join";
	readonly target: string;
	readonly guestIdentity: string;
	readonly guestName: string;
	readonly callback: string;
	readonly format: CliFormat;
	readonly help?: boolean;
}

export interface GuestLeaveCliOptions {
	readonly command: "guest-leave";
	readonly target: string;
	readonly crewId: string;
	readonly guestIdentity: string;
	readonly callback: string;
	readonly format: CliFormat;
	readonly help?: boolean;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

function validValue(value: string | undefined): value is string {
	return value !== undefined && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function requireValue(value: string | undefined, flag: string): string {
	if (!validValue(value)) throw new UsageError(`Guest ${flag} requires a non-empty value.`);
	return value;
}

function normalizeFormat(value: string | undefined, flag = "--format"): CliFormat {
	const format = value ?? "toon";
	if (!isCliFormat(format)) throw new UsageError(`Invalid ${flag} '${format}'; valid alternatives: toon, json, text`);
	return format;
}

function tokenize(args: readonly string[]): { tokens: string[]; format: string | undefined; help: boolean } {
	const tokens: string[] = [];
	let format: string | undefined;
	let help = false;
	for (let index = 0; index < args.length; index += 1) {
		const raw = args[index]!;
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--format") {
			if (format !== undefined) throw new UsageError("Duplicate flag: --format");
			format = equals > 0 ? raw.slice(equals + 1) : args[++index];
			continue;
		}
		if (flag === "--help") {
			help = true;
			continue;
		}
		tokens.push(raw);
	}
	return { tokens, format, help };
}

export function buildGuestJoinCommand(): Command {
	return new Command("join")
		.description("Request Guest admission from a live Member socket")
		.argument("<member-socket>", "Live Member socket path")
		.requiredOption("--identity <guest-identity>", "Stable Guest identity for idempotent replays")
		.requiredOption("--as <guest-name>", "Guest display name")
		.requiredOption("--callback <socket>", "This session's callback socket path")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function buildGuestLeaveCommand(): Command {
	return new Command("leave")
		.description("Leave one Crew by revoking the admission at its Member socket")
		.argument("<member-socket>", "Live Member socket path")
		.requiredOption("--crew <crew-id>", "Crew id to leave")
		.requiredOption("--identity <guest-identity>", "This session's Guest identity")
		.requiredOption("--callback <socket>", "The callback socket path used at join time")
		.option("--format <format>", "Output format: toon (default), json, or text", "toon")
		.showHelpAfterError(false)
		.helpOption(false);
}

function parseWith(
	command: Command,
	args: readonly string[],
	parse: (options: Record<string, unknown>, target: string) => Record<string, unknown>,
): Record<string, unknown> {
	const program = command.exitOverride().configureOutput({
		writeOut: () => {},
		writeErr: () => {},
		outputError: () => {},
	});
	let options: Record<string, unknown>;
	try {
		program.parse([...args], { from: "user" });
		options = program.opts();
	} catch (error) {
		if (error instanceof CommanderError) {
			const match = /--[a-z-]+/.exec(error.message);
			const flag = match?.[0] ?? "--as";
			throw new UsageError(
				error.code === "commander.optionMissingArgument" ? `Missing value for ${flag}` : error.message,
			);
		}
		throw error;
	}
	const positional = program.args[0];
	if (!validValue(positional)) throw new UsageError("Guest commands require one live Member socket target.");
	return parse(options, positional);
}

export function parseGuestJoinCommand(args: readonly string[]): GuestJoinCliOptions {
	const { tokens, format, help } = tokenize(args);
	if (help)
		return {
			command: "guest-join",
			target: "",
			guestIdentity: "",
			guestName: "",
			callback: "",
			format: normalizeFormat(format),
			help: true,
		};
	const options = parseWith(buildGuestJoinCommand(), tokens, (opts, target) => {
		if (opts.as !== undefined && !validValue(String(opts.as)))
			throw new UsageError("Guest --as requires a non-empty value.");
		return { ...opts, target };
	});
	return {
		command: "guest-join",
		target: String(options.target),
		guestIdentity: requireValue(String(options.identity ?? ""), "--identity <guest-identity>"),
		guestName: requireValue(String(options.as ?? ""), "--as <guest-name>"),
		callback: requireValue(String(options.callback ?? ""), "--callback <socket>"),
		format: normalizeFormat(format),
	};
}

export function parseGuestLeaveCommand(args: readonly string[]): GuestLeaveCliOptions {
	const { tokens, format, help } = tokenize(args);
	if (help)
		return {
			command: "guest-leave",
			target: "",
			crewId: "",
			guestIdentity: "",
			callback: "",
			format: normalizeFormat(format),
			help: true,
		};
	const options = parseWith(buildGuestLeaveCommand(), tokens, (opts, target) => ({ ...opts, target }));
	return {
		command: "guest-leave",
		target: String(options.target),
		crewId: requireValue(String(options.crew ?? ""), "--crew <crew-id>"),
		guestIdentity: requireValue(String(options.identity ?? ""), "--identity <guest-identity>"),
		callback: requireValue(String(options.callback ?? ""), "--callback <socket>"),
		format: normalizeFormat(format),
	};
}

export function guestJoinHelp(): string {
	return [
		"pi-bebop guest join <member-socket> --identity <guest-identity> --as <guest-name> --callback <socket> [--format toon|json|text]",
		"",
		"Request Guest admission from one live Member. The response stays `pending`",
		"until an exact configured approver accepts; repeating the identical request",
		"is idempotent. Never exposes capabilities or manifest internals.",
		"",
		"Options:",
		"  --identity <guest-identity> Stable Guest identity (required; keep it stable)",
		"  --as <guest-name>           Guest display name (required)",
		"  --callback <socket>    This session's callback socket path (required)",
		"  --format <format>      toon (default), json, or text",
		"",
		"Use `/guest crews` inside the session to list pending and approved crews.",
		"",
	].join("\n");
}

export function guestLeaveHelp(): string {
	return [
		"pi-bebop guest leave <member-socket> --crew <crew-id> --identity <guest-identity> --callback <socket> [--format toon|json|text]",
		"",
		"Revoke one Crew membership at its Member socket. The Member validates the",
		"guest identity, crew id, and callback endpoint before revoking.",
		"",
		"Options:",
		"  --crew <crew-id>            Crew id to leave (required)",
		"  --identity <guest-identity> Guest identity used at join time (required)",
		"  --callback <socket>         Callback socket path used at join time (required)",
		"  --format <format>           toon (default), json, or text",
		"",
	].join("\n");
}

export interface GuestCliDependencies {
	readonly sendCommand: typeof sendRpcCommand;
}

export const defaultGuestCliDependencies: GuestCliDependencies = { sendCommand: sendRpcCommand };

/**
 * Maps transport failures to stable member-side codes: wire rejections carry
 * the member's admission code ("remote-error: <code>"); everything else falls
 * back to the shared transport mapping.
 */
export function guestWireErrorCode(error: unknown): string {
	if (error instanceof RpcProtocolError && error.code === "remote-error") {
		const memberCode = error.message.slice("remote-error:".length).trim();
		if (memberCode.length > 0) return memberCode;
	}
	if (error instanceof RpcProtocolError) return error.code;
	const code = errorCode(error);
	return code === "offline" ? "join-failed" : code;
}

function targetFromError(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "transport error";
}

export async function runGuestJoinCommand(
	options: GuestJoinCliOptions,
	_context: CliContext,
	deps: GuestCliDependencies = defaultGuestCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: guestJoinHelp() };
	try {
		const { response } = await deps.sendCommand(
			options.target,
			{
				type: "guest_join",
				guestIdentity: options.guestIdentity,
				guestName: options.guestName,
				callbackEndpoint: options.callback,
			},
			{ timeout: 5000 },
		);
		if (!response.success || !isGuestJoinResult(response.data)) {
			return {
				kind: "result",
				result: errorResult(
					response.error ?? "invalid admission response",
					options.target,
					response.error ?? "invalid-admission-response",
				),
				format: options.format,
				full: false,
			};
		}
		return {
			kind: "result",
			result: {
				ok: true,
				target: options.target,
				status: response.data.status,
				data: {
					status: response.data.status,
					requestId: response.data.requestId,
					crew: response.data.crew,
					next:
						response.data.status === "pending"
							? "wait for an exact configured approver to run /crew guest approve"
							: "admission approved",
				},
			},
			format: options.format,
			full: false,
		};
	} catch (error) {
		const code = guestWireErrorCode(error);
		return {
			kind: "result",
			result: errorResult(targetFromError(error), options.target, code),
			format: options.format,
			full: false,
		};
	}
}

export async function runGuestLeaveCommand(
	options: GuestLeaveCliOptions,
	_context: CliContext,
	deps: GuestCliDependencies = defaultGuestCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: guestLeaveHelp() };
	try {
		const { response } = await deps.sendCommand(
			options.target,
			{
				type: "guest_leave",
				guestIdentity: options.guestIdentity,
				crewId: options.crewId,
				callbackEndpoint: options.callback,
			},
			{ timeout: 5000 },
		);
		if (!response.success) {
			return {
				kind: "result",
				result: errorResult(
					response.error ?? "remote rejection",
					options.target,
					response.error ?? "leave-failed",
				),
				format: options.format,
				full: false,
			};
		}
		return {
			kind: "result",
			result: {
				ok: true,
				target: options.target,
				status: "left",
				data: { status: "left", crew: options.crewId },
			},
			format: options.format,
			full: false,
		};
	} catch (error) {
		const code = guestWireErrorCode(error);
		return {
			kind: "result",
			result: errorResult(targetFromError(error), options.target, code),
			format: options.format,
			full: false,
		};
	}
}
