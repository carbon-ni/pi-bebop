import { Command } from "commander";
import {
	isMessagePayload,
	isMethodResult,
	type RpcCommandResponse,
	type SessionCaptureResult,
} from "../../domain/index.ts";
import {
	createCrewTargetResolver,
	CrewRouteResolutionError,
	type CrewRouteCaller,
	type ResolvedCrewRoute,
} from "../../application/crew-target-resolution.ts";
import { sendRpcCommand, RpcProtocolError } from "../../infra/rpc-client.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { errorResult } from "../support/errors.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";
import { resolveSourceSession, type SourceResolution } from "../support/source-session.ts";
import { MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS, MAX_MEMBER_REQUEST_TIMEOUT_SECONDS } from "../../domain/index.ts";
import { parsePositiveDurationMs } from "../support/duration.ts";

const FORMATS = ["toon", "json", "text"] as const;
const DEFAULT_RESPONSE_GRACE_SECONDS = 30;
const DEFAULT_TOTAL_WAIT_SECONDS = 120;
const DISCOVERY_TIMEOUT_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_TARGET_BYTES = 256;

export interface AskCliOptions {
	readonly command: "ask";
	readonly target: string;
	readonly question: string;
	readonly session?: string;
	readonly instructions: string[];
	readonly responseGraceSeconds: number;
	readonly totalWaitSeconds: number;
	readonly format: CliFormat;
}

function collect(value: string, previous: string[]): string[] {
	return previous.concat(value);
}

function format(value: string | undefined): CliFormat {
	const selected = value ?? defaultFormatForCommand("ask");
	if (!FORMATS.includes(selected as CliFormat))
		throw new UsageError(`Invalid --format '${selected}'; valid alternatives: toon, json, text`);
	return selected as CliFormat;
}

function duration(value: string, label: string, minimum: number, maximum: number): number {
	let milliseconds: number;
	try {
		milliseconds = parsePositiveDurationMs(value);
	} catch {
		throw new UsageError(`Invalid ${label} '${value}'; use a whole-second duration`);
	}
	if (milliseconds % 1000 !== 0 || milliseconds < minimum * 1000 || milliseconds > maximum * 1000)
		throw new UsageError(
			`Invalid ${label} '${value}'; use a whole-second duration from ${minimum}s through ${maximum}s`,
		);
	return milliseconds / 1000;
}

export function buildAskCommand(): Command {
	return new Command("ask")
		.description("Ask one exact Crew or Member and wait for its correlated Response")
		.argument("<target>", "Crew selector or exact Crew/Member target")
		.argument("<question>", "Question requiring one correlated Response")
		.option("--session <id|alias>", "Source joined Pi session (default: PI_SESSION_ID)")
		.option("--instruction <text>", "Instruction (repeatable, ordered)", collect, [])
		.option("--response-grace <duration>", "Post-idle Response grace (default 30s)", "30s")
		.option("--timeout <duration>", "Total Ask wait (default 120s)", "120s")
		.option("--format <format>", "Output format: text (default), toon, or json", defaultFormatForCommand("ask"))
		.addHelpText(
			"after",
			"\nAccepted is not answered. Ask sends exactly one correlated Member Request; delivery uncertainty is never retried.\n",
		);
}

export function readAskCommand(command: Command): AskCliOptions {
	const opts = command.opts<{
		session?: string;
		instruction?: string[];
		responseGrace?: string;
		timeout?: string;
		format?: string;
	}>();
	const target = command.args[0];
	const question = command.args[1];
	if (!target || target.trim() !== target || Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES)
		throw new UsageError("Missing or invalid <target>; use <crew-selector[/member]>");
	if (!question || !isMessagePayload({ content: question }))
		throw new UsageError("Missing or invalid <question>; provide non-empty UTF-8 text");
	const responseGraceSeconds = duration(
		opts.responseGrace ?? `${DEFAULT_RESPONSE_GRACE_SECONDS}s`,
		"--response-grace",
		1,
		MAX_MEMBER_REQUEST_TIMEOUT_SECONDS,
	);
	const totalWaitSeconds = duration(
		opts.timeout ?? `${DEFAULT_TOTAL_WAIT_SECONDS}s`,
		"--timeout",
		2,
		MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	);
	if (totalWaitSeconds <= responseGraceSeconds)
		throw new UsageError("--timeout must be strictly greater than --response-grace");
	return {
		command: "ask",
		target,
		question,
		...(opts.session === undefined ? {} : { session: String(opts.session) }),
		instructions: opts.instruction ?? [],
		responseGraceSeconds,
		totalWaitSeconds,
		format: format(opts.format),
	};
}

export interface AskSourceCapture {
	readonly crewLocator: string;
	readonly crew: { readonly id?: string; readonly displayName?: string };
	readonly member?: { readonly name: string; readonly role: string };
	readonly guest?: { readonly identity: string; readonly name: string; readonly capabilities: readonly string[] };
	readonly projectRoot: string;
}

export interface AskCliDependencies {
	readonly resolveSource: (input: { explicitSession?: string; environmentSession?: string }) => SourceResolution;
	readonly environmentSession: (environment?: NodeJS.ProcessEnv) => string | undefined;
	readonly capture: (source: SourceResolution & { ok: true }, signal: AbortSignal) => Promise<AskSourceCapture>;
	readonly resolveRoute: (
		capture: AskSourceCapture,
		target: string,
		signal: AbortSignal,
	) => Promise<ResolvedCrewRoute>;
	readonly send: (
		source: SourceResolution & { ok: true },
		command: unknown,
		timeoutMs: number,
		signal: AbortSignal,
	) => Promise<{ response: RpcCommandResponse }>;
	readonly wait: (
		source: SourceResolution & { ok: true },
		requestId: string,
		timeoutMs: number,
		signal: AbortSignal,
	) => Promise<{ response: RpcCommandResponse }>;
}

async function rpcWithSessionFallback<T>(
	source: SourceResolution & { ok: true },
	operation: (socketPath: string) => Promise<T>,
): Promise<T> {
	try {
		return await operation(source.idSocketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return operation(source.aliasSocketPath);
	}
}

function captureFromResult(response: RpcCommandResponse): AskSourceCapture {
	if (!response.success || !isMethodResult("session.capture", response.data))
		throw new RpcProtocolError("malformed-response", "Source session capture was unavailable");
	const data = response.data as SessionCaptureResult;
	if (!data.crewLocator || !data.crew.id || (!data.member && !data.guest))
		throw new RpcProtocolError("authorization-required", "Source session is not an authorized Crew route");
	return {
		crewLocator: data.crewLocator,
		crew: data.crew,
		...(data.member === undefined ? {} : { member: data.member }),
		...(data.guest === undefined ? {} : { guest: data.guest }),
		projectRoot: data.session.root,
	};
}

function callerFromCapture(capture: AskSourceCapture): CrewRouteCaller {
	if (capture.guest)
		return {
			kind: "guest",
			crewSelector: capture.crew.id!,
			crewLocator: capture.crewLocator,
			guestIdentity: capture.guest.identity,
			guestName: capture.guest.name,
			approved: true,
			capabilities: capture.guest.capabilities,
		};
	if (!capture.member) throw new RpcProtocolError("authorization-required", "Source session route is unavailable");
	return {
		kind: "member",
		crewSelector: capture.crew.id!,
		crewLocator: capture.crewLocator,
		memberName: capture.member.name,
		role: capture.member.role,
		trusted: true,
	};
}

export const defaultAskCliDependencies: AskCliDependencies = {
	resolveSource: (input) => resolveSourceSession(input),
	environmentSession: (environment = process.env) => environment.PI_SESSION_ID,
	capture: async (source, signal) => {
		const result = await rpcWithSessionFallback(source, (socket) =>
			sendRpcCommand(socket, { type: "session_capture" }, { timeout: DISCOVERY_TIMEOUT_MS, signal }),
		);
		return captureFromResult(result.response);
	},
	resolveRoute: async (capture, target, signal) => {
		const resolve = createCrewTargetResolver({ isProjectTrusted: () => true });
		return resolve({
			target,
			projectRoot: capture.projectRoot,
			locator: capture.crewLocator,
			caller: callerFromCapture(capture),
			action: "member-request",
			signal,
		});
	},
	send: async (source, command, timeoutMs, signal) =>
		rpcWithSessionFallback(source, (socket) =>
			sendRpcCommand(socket, command as never, { timeout: timeoutMs, signal }),
		),
	wait: async (source, requestId, timeoutMs, signal) =>
		rpcWithSessionFallback(source, (socket) =>
			sendRpcCommand(socket, { type: "member_request_wait", requestId }, { timeout: timeoutMs, signal }),
		),
};

function errorOutcome(options: AskCliOptions, code: string, message: string, data?: unknown): CliOutcome {
	const result = errorResult(message, options.target, code);
	const status = ["unknown-crew", "unknown-member", "ambiguous-crew", "self-target"].includes(code)
		? "usage"
		: result.status;
	return {
		kind: "result",
		result: { ...result, status, ...(data === undefined ? {} : { data }) },
		format: options.format,
		full: false,
	};
}

function mapError(error: unknown): { code: string; message: string; data?: unknown } {
	if (error instanceof CrewRouteResolutionError) return { code: error.code, message: error.recovery };
	if (error instanceof RpcProtocolError) {
		if (error.code === "outcome-unknown")
			return {
				code: "delivery-timeout-unknown",
				message: "Delivery acceptance is unknown; do not retry automatically.",
				data: { acceptance: "unknown", safeRetry: false },
			};
		return {
			code: error.code,
			message: error.code === "remote-error" ? "The source session rejected the Ask." : "Ask transport failed",
		};
	}
	if (error instanceof Error && error.name === "AbortError") return { code: "cancelled", message: "Ask cancelled" };
	if (error instanceof Error && /timeout/i.test(error.message)) return { code: "timeout", message: "Ask timed out" };
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN")
		return { code: "offline", message: "Source session is offline" };
	return { code: "ask-failed", message: "Ask failed" };
}

async function discoverAskRoute(
	options: AskCliOptions,
	context: CliContext,
	deps: AskCliDependencies,
	source: SourceResolution & { ok: true },
): Promise<{ ok: true; route: ResolvedCrewRoute } | { ok: false; outcome: CliOutcome }> {
	try {
		const capture = await deps.capture(source, context.signal);
		return { ok: true, route: await deps.resolveRoute(capture, options.target, context.signal) };
	} catch (error) {
		const mapped = mapError(error);
		return {
			ok: false,
			outcome: errorOutcome(
				options,
				mapped.code === "timeout" ? "discovery-timeout" : mapped.code,
				mapped.message,
				mapped.data,
			),
		};
	}
}

async function deliverAsk(
	options: AskCliOptions,
	context: CliContext,
	deps: AskCliDependencies,
	source: SourceResolution & { ok: true },
	route: ResolvedCrewRoute,
): Promise<{ ok: true; requestId: string } | { ok: false; outcome: CliOutcome }> {
	const command = {
		type: "member_request_start",
		target: route.target.member.name,
		message: options.question,
		...(options.instructions.length === 0 ? {} : { instructions: options.instructions }),
		timeoutSeconds: options.responseGraceSeconds,
		maxWaitSeconds: options.totalWaitSeconds,
		...(route.caller.kind === "guest" ? { crew: route.target.crew.selector } : {}),
	};
	try {
		const result = await deps.send(source, command, DELIVERY_TIMEOUT_MS, context.signal);
		if (!result.response.success || !isMethodResult("member.request_start", result.response.data))
			return {
				ok: false,
				outcome: errorOutcome(
					options,
					"delivery-rejected",
					"The Member Request was rejected before acceptance.",
				),
			};
		const data = result.response.data as { accepted?: boolean; requestId?: string };
		if (data.accepted !== true || typeof data.requestId !== "string")
			return {
				ok: false,
				outcome: errorOutcome(options, "malformed-response", "The Member Request acceptance was malformed."),
			};
		return { ok: true, requestId: data.requestId };
	} catch (error) {
		const mapped = mapError(error);
		if (!["timeout", "delivery-timeout-unknown", "cancelled"].includes(mapped.code))
			return { ok: false, outcome: errorOutcome(options, mapped.code, mapped.message, mapped.data) };
		const code = mapped.code === "timeout" ? "delivery-timeout-unknown" : mapped.code;
		const message =
			mapped.code === "cancelled"
				? "Ask cancelled during delivery."
				: "Delivery acceptance is unknown; do not retry automatically.";
		return {
			ok: false,
			outcome: errorOutcome(options, code, message, { acceptance: "unknown", safeRetry: false }),
		};
	}
}

async function awaitAskOutcome(
	options: AskCliOptions,
	context: CliContext,
	deps: AskCliDependencies,
	source: SourceResolution & { ok: true },
	route: ResolvedCrewRoute,
	requestId: string,
): Promise<CliOutcome> {
	try {
		const result = await deps.wait(source, requestId, options.totalWaitSeconds * 1000, context.signal);
		if (!result.response.success || !isMethodResult("member.request_wait", result.response.data))
			return errorOutcome(options, "malformed-response", "The Ask outcome was malformed.");
		const data = result.response.data as {
			kind?: string;
			message?: string;
			instructions?: readonly string[];
			requestAgeMs?: number;
		};
		if (data.kind === "response" && typeof data.message === "string")
			return {
				kind: "result",
				result: {
					ok: true,
					target: options.target,
					status: "response",
					response: data.message,
					data: {
						crew: route.target.crew,
						member: route.target.member,
						answer: data.message,
						...(data.instructions === undefined ? {} : { instructions: data.instructions }),
						...(data.requestAgeMs === undefined ? {} : { freshness: { requestAgeMs: data.requestAgeMs } }),
					},
				},
				format: options.format,
				full: false,
			};
		if (data.kind === "pending")
			return errorOutcome(
				options,
				"timeout-after-idle",
				"No Response arrived during the post-idle grace period.",
				{ outcome: "timeout-after-idle", safeRetry: false },
			);
		if (data.kind === "timeout")
			return errorOutcome(options, "timeout-total", "No Response arrived before the total Ask timeout.", {
				outcome: "timeout-total",
				safeRetry: false,
			});
		if (data.kind === "offline")
			return errorOutcome(options, "route-lost", "The target route was lost before a Response.");
		return errorOutcome(options, "malformed-response", "The Ask outcome was malformed.");
	} catch (error) {
		const mapped = mapError(error);
		return errorOutcome(
			options,
			mapped.code === "timeout" ? "timeout-total" : mapped.code,
			mapped.message,
			mapped.data,
		);
	}
}

export async function runAskCommand(
	options: AskCliOptions,
	context: CliContext,
	deps: AskCliDependencies = defaultAskCliDependencies,
): Promise<CliOutcome> {
	const source = deps.resolveSource({
		explicitSession: options.session,
		environmentSession: deps.environmentSession(context.environment),
	});
	if (source.ok === false) throw new UsageError(source.message);
	const discovered = await discoverAskRoute(options, context, deps, source);
	if (discovered.ok === false) return discovered.outcome;
	const delivered = await deliverAsk(options, context, deps, source, discovered.route);
	if (delivered.ok === false) return delivered.outcome;
	return await awaitAskOutcome(options, context, deps, source, discovered.route, delivered.requestId);
}
