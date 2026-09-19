import { Command } from "commander";
import { isGuestJoinResult } from "../../domain/index.ts";
import type { GuestTrustedManifest } from "../../application/guest-message.ts";
import { promises as fs } from "node:fs";
import { submitGuestBroadcast, submitGuestMessage } from "../../application/guest-message.ts";
import { createGuestMembershipRuntime } from "../../infra/guest-membership-runtime.ts";
import { getTrustedCrewManifestPaths, readTrustedCrewManifest } from "../../infra/crew-manifest-store.ts";
import { createGuestRegistryStore } from "../../infra/guest-registry-store.ts";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { errorCode, errorResult } from "../support/errors.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";

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
}

export interface GuestLeaveCliOptions {
	readonly command: "guest-leave";
	readonly target: string;
	readonly crewId: string;
	readonly guestIdentity: string;
	readonly callback: string;
	readonly format: CliFormat;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

export interface GuestMessageCliOptions {
	readonly command: "guest-send" | "guest-broadcast";
	readonly crew: string;
	readonly target?: string;
	readonly guestIdentity: string;
	readonly guestName: string;
	readonly callback: string;
	readonly capability: string;
	readonly message: string;
	readonly instructions: string[];
	readonly format: CliFormat;
}

function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

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

function normalizeFormat(value: string | undefined): CliFormat {
	const format = value ?? defaultFormatForCommand("guest");
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return format;
}

export function buildGuestJoinCommand(): Command {
	return new Command("join")
		.description("Request Guest admission from a live Member socket")
		.argument("<member-socket>", "Live Member socket path")
		.requiredOption("--identity <guest-identity>", "Stable Guest identity for idempotent replays")
		.requiredOption("--as <guest-name>", "Guest display name")
		.requiredOption("--callback <socket>", "This session's callback socket path")
		.option(
			"--format <format>",
			"Output format: text (default), toon, or json",
			defaultFormatForCommand("guest-join"),
		)
		.addHelpText(
			"after",
			[
				"",
				"Request Guest admission from one live Member. The response stays `pending`",
				"until an exact configured approver accepts; repeating the identical request",
				"is idempotent. Never exposes capabilities or manifest internals.",
				"",
				"Use `/guest crews` inside the session to list pending and approved crews.",
			].join("\n"),
		);
}

export function buildGuestMessageCommand(kind: "send" | "broadcast"): Command {
	const command = new Command(kind)
		.description(kind === "send" ? "Send a direct Guest Follow-up" : "Broadcast directly to an approved Crew")
		.requiredOption("--crew <crew-id>", "Exact approved crew selector")
		.requiredOption("--identity <guest-identity>", "Stable Guest identity")
		.requiredOption("--as <guest-name>", "Approved Guest display name")
		.requiredOption("--callback <socket>", "This Guest callback socket")
		.requiredOption("--capability <capability>", "Member-issued Guest capability")
		.requiredOption("--message <text>", "Message text")
		.option("--instruction <value>", "Instruction (repeatable, ordered)", collect, [])
		.option("--format <format>", "Output format: text (default), toon, or json", defaultFormatForCommand("guest"))
		.addHelpText(
			"after",
			[
				"",
				kind === "send"
					? "Send one direct Guest Follow-up to an exact Member in the selected Crew."
					: "Send one transient Guest Broadcast directly to every other approved Crew participant.",
				"Every call requires an exact crew selector. Credentials are used only for the wire",
				"command and never rendered.",
			].join("\n"),
		);
	if (kind === "send") command.requiredOption("--target <member>", "Exact Member name or unique role");
	return command;
}

export function buildGuestLeaveCommand(): Command {
	return new Command("leave")
		.description("Leave one Crew by revoking the admission at its Member socket")
		.argument("<member-socket>", "Live Member socket path")
		.requiredOption("--crew <crew-id>", "Crew id to leave")
		.requiredOption("--identity <guest-identity>", "This session's Guest identity")
		.requiredOption("--callback <socket>", "The callback socket path used at join time")
		.option("--format <format>", "Output format: text (default), toon, or json", defaultFormatForCommand("guest"))
		.addHelpText(
			"after",
			[
				"",
				"Revoke one Crew membership at its Member socket. The Member validates the",
				"guest identity, crew id, and callback endpoint before revoking.",
			].join("\n"),
		);
}

export function readGuestJoinCommand(command: Command): GuestJoinCliOptions {
	const options = command.opts<{ identity?: string; as?: string; callback?: string; format?: string }>();
	if (!validValue(command.args[0])) throw new UsageError("Guest commands require one live Member socket target.");
	return {
		command: "guest-join",
		target: String(command.args[0]),
		guestIdentity: requireValue(options.identity, "--identity <guest-identity>"),
		guestName: requireValue(options.as, "--as <guest-name>"),
		callback: requireValue(options.callback, "--callback <socket>"),
		format: normalizeFormat(options.format),
	};
}

export function readGuestMessageCommand(command: Command, kind: "send" | "broadcast"): GuestMessageCliOptions {
	const options = command.opts<{
		crew?: string;
		target?: string;
		identity?: string;
		as?: string;
		callback?: string;
		capability?: string;
		message?: string;
		instruction?: string[];
		format?: string;
	}>();
	return {
		command: kind === "send" ? "guest-send" : "guest-broadcast",
		crew: requireValue(options.crew, "--crew <crew-id>"),
		target: kind === "send" ? requireValue(options.target, "--target <member>") : options.target,
		guestIdentity: requireValue(options.identity, "--identity <guest-identity>"),
		guestName: requireValue(options.as, "--as <guest-name>"),
		callback: requireValue(options.callback, "--callback <socket>"),
		capability: requireValue(options.capability, "--capability <capability>"),
		message: requireValue(options.message, "--message <text>"),
		instructions: options.instruction ?? [],
		format: normalizeFormat(options.format),
	};
}

export function readGuestLeaveCommand(command: Command): GuestLeaveCliOptions {
	const options = command.opts<{ crew?: string; identity?: string; callback?: string; format?: string }>();
	if (!validValue(command.args[0])) throw new UsageError("Guest commands require one live Member socket target.");
	return {
		command: "guest-leave",
		target: String(command.args[0]),
		crewId: requireValue(options.crew, "--crew <crew-id>"),
		guestIdentity: requireValue(options.identity, "--identity <guest-identity>"),
		callback: requireValue(options.callback, "--callback <socket>"),
		format: normalizeFormat(options.format),
	};
}

export interface GuestCliDependencies {
	readonly sendCommand: typeof sendRpcCommand;
}

export const defaultGuestCliDependencies: GuestCliDependencies = { sendCommand: sendRpcCommand };

async function loadGuestManifest(cwd: string, crewId: string): Promise<GuestTrustedManifest> {
	const candidates = getTrustedCrewManifestPaths(cwd);
	const matches: GuestTrustedManifest[] = [];
	for (const manifestPath of candidates) {
		try {
			await fs.access(manifestPath);
			const manifest = await readTrustedCrewManifest(manifestPath, cwd, () => true);
			if (manifest.crew?.id !== crewId) continue;
			const registry = createGuestRegistryStore({ manifestPath, crew: manifest.crew }).load();
			matches.push({
				crew: manifest.crew,
				members: manifest.members,
				approvedGuests: registry.entries
					.filter((entry) => entry.status === "approved")
					.map((entry) => ({
						guestIdentity: entry.guestIdentity,
						guestName: entry.guestName,
						callbackEndpoint: entry.callbackEndpoint,
					})),
			});
		} catch {
			// Missing or untrusted layouts are not candidates.
		}
	}
	if (matches.length !== 1)
		throw new UsageError(
			matches.length === 0
				? `No trusted crew manifest found for crew '${crewId}'.`
				: `Crew selector '${crewId}' matches multiple trusted manifests.`,
		);
	return matches[0]!;
}

function guestRuntime(options: GuestMessageCliOptions) {
	const runtime = createGuestMembershipRuntime({
		guestIdentity: options.guestIdentity,
		callbackEndpoint: options.callback,
		createRequestId: () => "cli-guest-request",
		submitJoinRequest: async () => undefined,
	});
	runtime.track(
		{
			crew: { id: options.crew, displayName: options.crew },
			guestName: options.guestName,
			memberSocket: "cli",
			submittedByMember: "cli",
		},
		"cli-guest-request",
		"approved",
		options.capability,
	);
	return runtime;
}

export async function runGuestMessageCommand(
	options: GuestMessageCliOptions,
	context: CliContext,
	deps: GuestCliDependencies = defaultGuestCliDependencies,
): Promise<CliOutcome> {
	try {
		const manifest = await loadGuestManifest(context.cwd, options.crew);
		const runtime = guestRuntime(options);
		const applicationDeps = { transport: { send: deps.sendCommand } };
		const result =
			options.command === "guest-send"
				? await submitGuestMessage(
						{
							guestRuntime: runtime,
							guestIdentity: options.guestIdentity,
							crew: options.crew,
							target: options.target!,
							message: options.message,
							instructions: options.instructions,
							loadManifest: async () => manifest,
							signal: context.signal,
						},
						applicationDeps,
					)
				: await submitGuestBroadcast(
						{
							guestRuntime: runtime,
							guestIdentity: options.guestIdentity,
							crew: options.crew,
							message: options.message,
							instructions: options.instructions,
							loadManifest: async () => manifest,
							signal: context.signal,
						},
						applicationDeps,
					);
		return {
			kind: "result",
			result: { ok: true, target: options.target ?? options.crew, status: "accepted", data: result },
			format: options.format,
			full: false,
		};
	} catch (error) {
		const code =
			error instanceof Error && "code" in error
				? String((error as { code: unknown }).code)
				: guestWireErrorCode(error);
		return {
			kind: "result",
			result: errorResult(targetFromError(error), options.target ?? options.crew, code),
			format: options.format,
			full: false,
		};
	}
}

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
