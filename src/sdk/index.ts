import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import {
	isSafeAlias,
	isSafeSessionId,
	isStatusResult,
	isMemberStatusResult,
	isMemberLastMessageResult,
	isMemberMessageResult,
	isMemberInboxSendResult,
	isMemberRequestResult,
	type MemberStatus as WireMemberStatus,
	type MemberRequestWaitResult,
} from "../domain/index.ts";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
} from "../domain/message-payload.ts";
import { getAliasPath, getSocketPath, CONTROL_DIR } from "../infra/intray-paths.ts";
import { RpcProtocolError, sendRpcCommand } from "../infra/rpc-client.ts";

const MAX_DISCOVERY_ENTRIES = 256;
const MAX_DISCOVERY_SOURCES = 100;
const MAX_TARGET_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 60_000;
const ASK_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_ASK_RESPONSE_GRACE_SECONDS = 30;
const MAX_ASK_RESPONSE_GRACE_SECONDS = 600;
const DEFAULT_ASK_TOTAL_WAIT_SECONDS = 120;
const MIN_ASK_TOTAL_WAIT_SECONDS = 2;
const MAX_ASK_TOTAL_WAIT_SECONDS = 1_800;

export type BebopClientErrorCode =
	| "invalid-input"
	| "source-required"
	| "invalid-session"
	| "unknown-session"
	| "offline-session"
	| "offline-member"
	| "route-lost"
	| "message-too-large"
	| "not-joined"
	| "untrusted"
	| "unknown-member"
	| "ambiguous-member"
	| "self-query"
	| "remote-rejected"
	| "malformed-response"
	| "timeout"
	| "aborted"
	| "transport-error"
	| "outcome-unknown";

export class BebopClientError extends Error {
	readonly code: BebopClientErrorCode;

	constructor(code: BebopClientErrorCode, message?: string) {
		super(message ?? defaultErrorMessage(code));
		this.name = "BebopClientError";
		this.code = code;
	}
}

export interface BebopOperationOptions {
	readonly signal?: AbortSignal;
	/** One end-to-end budget for discovery, selection, or one member operation. */
	readonly timeoutMs?: number;
}

export interface SourceSelector {
	/** Session id or safe alias. When omitted, PI_SESSION_ID is used. */
	readonly session?: string;
}

export type SourceState = "joined" | "online" | "unknown";

export interface BebopSourceInfo {
	readonly session: string;
	readonly aliases: readonly string[];
	readonly state: SourceState;
	readonly trusted: boolean;
}

export interface MemberStatusIdentity {
	readonly name: string;
	readonly role: string;
}

export interface MemberLastMessage {
	readonly role: "assistant";
	readonly content: string;
	readonly timestamp: number;
}

export interface MemberLastMessageResult {
	readonly member: MemberStatusIdentity;
	readonly message: MemberLastMessage | null;
}

export type MemberStatus =
	| {
			readonly member: MemberStatusIdentity;
			readonly presence: "online";
			readonly activity: "idle" | "busy" | "compacting";
			readonly hasPendingMessages: boolean;
			readonly observedAt: string;
	  }
	| {
			readonly member: MemberStatusIdentity;
			readonly presence: "offline";
			readonly activity: "unavailable";
			readonly hasPendingMessages: "unavailable";
			readonly observedAt: string;
	  };

export interface FollowUpInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface FollowUpResult {
	readonly member: MemberStatusIdentity;
	readonly deliveryId: string;
	readonly disposition: "direct" | "queued" | "steered";
}

export interface InboxInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface InboxResult {
	readonly member: MemberStatusIdentity;
	readonly itemId: string;
	readonly persisted: true;
	readonly hint: "sent" | "skipped";
}

export interface AskInput {
	readonly question: string;
	readonly instructions?: readonly string[];
}

export interface AskOptions {
	readonly signal?: AbortSignal;
	/** Post-idle grace before a nonterminal pending result is produced. */
	readonly responseGraceSeconds?: number;
	/** One end-to-end budget from dispatch through the correlated Response. */
	readonly totalWaitSeconds?: number;
}

export type AskResult =
	| {
			readonly status: "answered";
			readonly code: "response";
			readonly accepted: true;
			readonly answered: true;
			readonly safeRetry: false;
			readonly member: MemberStatusIdentity;
			readonly message: string;
			readonly instructions: readonly string[];
			readonly requestAgeMs?: number;
	  }
	| {
			readonly status: "offline";
			readonly code: "offline-member";
			readonly accepted: true;
			readonly answered: false;
			readonly safeRetry: false;
			readonly member: MemberStatusIdentity;
	  }
	| {
			readonly status: "timeout";
			readonly code: "timeout-after-idle" | "timeout-total";
			readonly accepted: true;
			readonly answered: false;
			readonly safeRetry: false;
			readonly member: MemberStatusIdentity;
	  };

export interface BebopSource {
	ask(member: string, input: AskInput, options?: AskOptions): Promise<AskResult>;
	getMemberStatus(member: string, options?: BebopOperationOptions): Promise<MemberStatus>;
	getMemberLastMessage(member: string, options?: BebopOperationOptions): Promise<MemberLastMessageResult>;
	sendFollowUp(member: string, input: FollowUpInput, options?: BebopOperationOptions): Promise<FollowUpResult>;
	sendToInbox(member: string, input: InboxInput, options?: BebopOperationOptions): Promise<InboxResult>;
}

export interface BebopClient {
	listSources(options?: BebopOperationOptions): Promise<readonly BebopSourceInfo[]>;
	selectSource(selector?: SourceSelector, options?: BebopOperationOptions): Promise<BebopSource>;
}

interface Budget {
	readonly signal: AbortSignal;
	readonly remaining: () => number;
	readonly timedOut: () => boolean;
	cleanup(): void;
}

class DeadlineExceeded extends Error {
	constructor() {
		super("deadline exceeded");
		this.name = "DeadlineExceeded";
	}
}

function defaultErrorMessage(code: BebopClientErrorCode): string {
	return (
		{
			"invalid-input": "Invalid SDK input",
			"source-required": "A source session is required",
			"invalid-session": "Invalid source session",
			"unknown-session": "Source session was not found",
			"offline-session": "Source session is offline",
			"offline-member": "Crew member is offline",
			"route-lost": "The route to the Crew member was lost",
			"message-too-large": "Crew member's last message is too large",
			"not-joined": "Source session is not joined to a crew",
			untrusted: "Source project is not trusted",
			"unknown-member": "Crew member was not found",
			"ambiguous-member": "Crew member selector is ambiguous",
			"self-query": "Cannot query the source member",
			"remote-rejected": "Source rejected the operation",
			"malformed-response": "Source returned a malformed response",
			timeout: "Bebop operation timed out",
			aborted: "Bebop operation was aborted",
			"transport-error": "Bebop transport failed",
			"outcome-unknown": "The operation may have been accepted but its acknowledgement was lost",
		} as Record<BebopClientErrorCode, string>
	)[code];
}

function invalidInput(): never {
	throw new BebopClientError("invalid-input");
}

function validateTimeout(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS)
		return invalidInput();
	return value;
}

function createBudget(options: BebopOperationOptions | undefined): Budget {
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
	const timeoutMs = validateTimeout(options?.timeoutMs);
	return createDeadlineBudget(options?.signal, timeoutMs);
}

function createDeadlineBudget(signal: AbortSignal | undefined, timeoutMs: number): Budget {
	const controller = new AbortController();
	let expired = false;
	const startedAt = Date.now();
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(new DeadlineExceeded());
	}, timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		remaining: () => Math.max(1, timeoutMs - (Date.now() - startedAt)),
		timedOut: () => expired,
		cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

async function withBudget<T>(
	options: BebopOperationOptions | undefined,
	operation: (budget: Budget) => Promise<T>,
): Promise<T> {
	const budget = createBudget(options);
	try {
		return await operation(budget);
	} catch (error) {
		throw normalizeError(error, budget);
	} finally {
		budget.cleanup();
	}
}

function validateAskOptions(options: AskOptions | undefined): {
	readonly responseGraceSeconds: number;
	readonly totalWaitSeconds: number;
} {
	const responseGraceSeconds = options?.responseGraceSeconds ?? DEFAULT_ASK_RESPONSE_GRACE_SECONDS;
	const totalWaitSeconds = options?.totalWaitSeconds ?? DEFAULT_ASK_TOTAL_WAIT_SECONDS;
	if (
		!Number.isInteger(responseGraceSeconds) ||
		responseGraceSeconds < 1 ||
		responseGraceSeconds > MAX_ASK_RESPONSE_GRACE_SECONDS
	)
		return invalidInput();
	if (
		!Number.isInteger(totalWaitSeconds) ||
		totalWaitSeconds < MIN_ASK_TOTAL_WAIT_SECONDS ||
		totalWaitSeconds > MAX_ASK_TOTAL_WAIT_SECONDS ||
		totalWaitSeconds <= responseGraceSeconds
	)
		return invalidInput();
	return { responseGraceSeconds, totalWaitSeconds };
}

function withAskBudget<T>(
	options: AskOptions | undefined,
	settings: { readonly totalWaitSeconds: number },
	operation: (budget: Budget) => Promise<T>,
): Promise<T> {
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
	const budget = createDeadlineBudget(options?.signal, settings.totalWaitSeconds * 1000);
	return operation(budget)
		.catch((error) => {
			throw normalizeError(error, budget);
		})
		.finally(() => budget.cleanup());
}

function budgetAbortReason(budget: Budget): unknown {
	return budget.timedOut() ? new DeadlineExceeded() : (budget.signal.reason ?? new Error("aborted"));
}

/** Race non-abortable filesystem promises without abandoning their rejection handlers. */
function awaitBudget<T>(operation: PromiseLike<T>, budget: Budget): Promise<T> {
	const pending = Promise.resolve(operation);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(budgetAbortReason(budget));
		};
		const cleanup = () => budget.signal.removeEventListener("abort", onAbort);
		budget.signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (budget.signal.aborted) onAbort();
	});
}

function normalizeError(error: unknown, budget: Budget): BebopClientError {
	if (error instanceof BebopClientError) return error;
	// sendRpcCommand classifies an acknowledgement lost after dispatch as
	// outcome-unknown. Preserve that side-effect boundary before translating
	// the shared deadline/cancellation signal.
	if (error instanceof RpcProtocolError && error.code === "outcome-unknown")
		return new BebopClientError("outcome-unknown");
	if (budget.timedOut()) return new BebopClientError("timeout");
	if (budget.signal.aborted) return new BebopClientError("aborted");
	if (error instanceof RpcProtocolError) {
		if (
			[
				"not-joined",
				"offline-member",
				"message-too-large",
				"untrusted",
				"untrusted-project",
				"unknown-member",
				"ambiguous-member",
				"ambiguous-role",
				"self-query",
				"self-send",
			].includes(error.code)
		)
			return mapRemoteError(error.code);
		if (error.code === "malformed-response" || error.code === "invalid-result" || error.code === "mismatched-id")
			return new BebopClientError("malformed-response");
		if (error.code === "remote-error") return mapRemoteError(error.message.replace(/^remote-error:\s*/, ""));
	}
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return new BebopClientError("unknown-session");
	if (
		code === "ECONNREFUSED" ||
		code === "ENOTCONN" ||
		code === "EPIPE" ||
		code === "EPROTOTYPE" ||
		code === "ENOTSOCK"
	)
		return new BebopClientError("offline-session");
	if (error instanceof Error && /timeout|timed? ?out/i.test(error.message)) return new BebopClientError("timeout");
	return new BebopClientError("transport-error");
}

function mapRemoteError(message: string): BebopClientError {
	const code = message.trim().split(/[:\s]/u, 1)[0];
	const known: Partial<Record<string, BebopClientErrorCode>> = {
		"not-joined": "not-joined",
		"offline-member": "offline-member",
		"message-too-large": "message-too-large",
		untrusted: "untrusted",
		"untrusted-project": "untrusted",
		"unknown-member": "unknown-member",
		"ambiguous-member": "ambiguous-member",
		"ambiguous-role": "ambiguous-member",
		"self-query": "self-query",
		"self-send": "self-query",
		"malformed-response": "malformed-response",
		aborted: "aborted",
		"outcome-unknown": "outcome-unknown",
	};
	return new BebopClientError(known[code] ?? "remote-rejected");
}

function validateSession(value: string): void {
	if (
		value.length === 0 ||
		value !== value.trim() ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_TARGET_BYTES ||
		(!isSafeSessionId(value) && !isSafeAlias(value))
	)
		throw new BebopClientError("invalid-session");
}

function validateMember(value: string): void {
	if (
		value.length === 0 ||
		value !== value.trim() ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_TARGET_BYTES
	)
		invalidInput();
}

function validateMessage(message: string): void {
	if (
		typeof message !== "string" ||
		message.length === 0 ||
		message.trim().length === 0 ||
		message.includes("\0") ||
		Buffer.byteLength(message, "utf8") > MAX_MESSAGE_CONTENT_BYTES
	)
		invalidInput();
}

function validateInstructions(instructions: readonly string[] | undefined): void {
	if (instructions === undefined) return;
	if (!Array.isArray(instructions) || instructions.length > MAX_MESSAGE_INSTRUCTIONS) invalidInput();
	for (const instruction of instructions) {
		if (
			typeof instruction !== "string" ||
			instruction.length === 0 ||
			instruction !== instruction.trim() ||
			instruction.includes("\0") ||
			Buffer.byteLength(instruction, "utf8") > MAX_MESSAGE_INSTRUCTION_BYTES
		)
			invalidInput();
	}
}

function validateEffectPayload(
	message: string,
	instructions: readonly string[] | undefined,
	kind: "follow-up" | "inbox" | "member request",
): void {
	// Source runtimes add these fields before persistence/delivery. Use valid
	// one-byte control characters to conservatively model their escaped size.
	const maxEscapedOriginField = "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES);
	const payload = {
		content: message,
		...(instructions === undefined ? {} : { instructions: [...instructions] }),
		origin: { kind: "crew", name: maxEscapedOriginField, role: maxEscapedOriginField },
		kind,
		sentAt: Number.MAX_SAFE_INTEGER,
	};
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_MESSAGE_PAYLOAD_BYTES) invalidInput();
}

async function controlledSocket(candidate: string, budget: Budget): Promise<string> {
	try {
		const [root, resolved] = await Promise.all([
			awaitBudget(fs.realpath(CONTROL_DIR), budget),
			awaitBudget(fs.realpath(candidate), budget),
		]);
		const relative = path.relative(root, resolved);
		const base = path.basename(resolved);
		if (
			!relative ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative) ||
			!base.endsWith(".sock") ||
			!isSafeSessionId(base.slice(0, -5))
		)
			return invalidControlledSocket();
		return resolved;
	} catch (error) {
		throw error;
	}
}

function invalidControlledSocket(): never {
	throw new BebopClientError("unknown-session");
}

async function aliasSocket(alias: string, budget: Budget): Promise<string> {
	const aliasPath = getAliasPath(alias);
	const [root, resolved] = await Promise.all([
		awaitBudget(fs.realpath(CONTROL_DIR), budget),
		awaitBudget(fs.realpath(aliasPath), budget),
	]);
	const relative = path.relative(root, resolved);
	const base = path.basename(resolved);
	if (
		!relative ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		!base.endsWith(".sock") ||
		!isSafeSessionId(base.slice(0, -5))
	)
		return invalidControlledSocket();
	return resolved;
}

async function sourceCandidates(session: string, budget: Budget): Promise<string[]> {
	const candidates: string[] = [];
	if (isSafeSessionId(session)) candidates.push(getSocketPath(session));
	if (isSafeAlias(session)) {
		try {
			candidates.push(await aliasSocket(session, budget));
		} catch (error) {
			if (budget.signal.aborted) throw error;
			// A malformed or stale alias cannot override a valid session-id candidate.
		}
	}
	return [...new Set(candidates)];
}

async function querySource(endpoint: string, budget: Budget): Promise<ReturnType<typeof parseStatus>> {
	const resolved = await controlledSocket(endpoint, budget);
	const { response } = await sendRpcCommand(
		resolved,
		{ type: "status" },
		{ timeout: budget.remaining(), signal: budget.signal },
	);
	if (!response.success) throw new RpcProtocolError("remote-error", response.error ?? "source rejected status query");
	if (!isStatusResult(response.data)) throw new RpcProtocolError("malformed-response", "invalid status response");
	return parseStatus(response.data);
}

function parseStatus(value: { status: "stopped" | "online" | "joined"; projectTrusted?: true }) {
	return {
		state: value.status === "stopped" ? "unknown" : value.status,
		trusted: value.projectTrusted === true,
	} as const;
}

function sourceClient(endpoint: string): BebopSource {
	const call = async <T>(
		command: Parameters<typeof sendRpcCommand>[1],
		options: BebopOperationOptions | undefined,
		parse: (value: unknown) => T,
		classifyLostAck = false,
	): Promise<T> =>
		withBudget(options, async (budget) => {
			const { response } = await sendRpcCommand(endpoint, command, {
				timeout: budget.remaining(),
				signal: budget.signal,
				classifyLostAck,
			});
			if (!response.success)
				throw new RpcProtocolError("remote-error", response.error ?? "source rejected operation");
			return parse(response.data);
		});

	return {
		ask(member, input, options) {
			validateMember(member);
			if (!input || typeof input !== "object") return invalidInput();
			validateMessage(input.question);
			validateInstructions(input.instructions);
			validateEffectPayload(input.question, input.instructions, "member request");
			const settings = validateAskOptions(options);
			return withAskBudget(options, settings, async (budget) => {
				let acceptedMember: MemberStatusIdentity | undefined;
				try {
					const started = await sendRpcCommand(
						endpoint,
						{
							type: "member_request_start",
							target: member,
							message: input.question,
							...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
							timeoutSeconds: settings.responseGraceSeconds,
							// The wire protocol keeps requests alive for at least 60 seconds. The SDK's
							// shorter local budget bounds this call; local expiry returns timeout-total
							// while the already-accepted server-side request may remain live.
							maxWaitSeconds: Math.max(60, settings.totalWaitSeconds),
						},
						{
							timeout: Math.min(ASK_DELIVERY_TIMEOUT_MS, budget.remaining()),
							signal: budget.signal,
							classifyLostAck: true,
						},
					);
					const accepted = started.response.data;
					if (!isMemberRequestResult(accepted))
						throw new RpcProtocolError("malformed-response", "Invalid member request acceptance");
					acceptedMember = accepted.member;
					for (;;) {
						const waited = await sendRpcCommand(
							endpoint,
							{ type: "member_request_wait", requestId: accepted.requestId },
							{ timeout: budget.remaining(), signal: budget.signal },
						);
						const outcome = waited.response.data as MemberRequestWaitResult;
						if (outcome.requestId !== accepted.requestId)
							throw new RpcProtocolError(
								"malformed-response",
								"Member request response id did not match the Ask",
							);
						if (outcome.kind === "pending") continue;
						if (outcome.kind === "response")
							return {
								status: "answered" as const,
								code: "response" as const,
								accepted: true as const,
								answered: true as const,
								safeRetry: false as const,
								member: outcome.member,
								message: outcome.message,
								instructions: [...outcome.instructions],
								...(outcome.requestAgeMs === undefined ? {} : { requestAgeMs: outcome.requestAgeMs }),
							};
						if (outcome.kind === "offline")
							return {
								status: "offline" as const,
								code: "offline-member" as const,
								accepted: true as const,
								answered: false as const,
								safeRetry: false as const,
								member: outcome.member,
							};
						return {
							status: "timeout" as const,
							code: "timeout-total" as const,
							accepted: true as const,
							answered: false as const,
							safeRetry: false as const,
							member: outcome.member,
						};
					}
				} catch (error) {
					if (acceptedMember !== undefined) {
						const normalized = normalizeError(error, budget);
						if (normalized.code === "timeout" && budget.timedOut())
							return {
								status: "timeout" as const,
								code: "timeout-total" as const,
								accepted: true as const,
								answered: false as const,
								safeRetry: false as const,
								member: acceptedMember,
							};
						if (normalized.code === "timeout" || normalized.code === "aborted")
							throw new BebopClientError("outcome-unknown");
						if (
							normalized.code === "offline-session" ||
							normalized.code === "unknown-session" ||
							normalized.code === "transport-error" ||
							normalized.code === "outcome-unknown"
						)
							throw new BebopClientError("route-lost");
					}
					throw error;
				}
			});
		},
		getMemberStatus(member, options) {
			validateMember(member);
			return call({ type: "member_status_target", target: member }, options, (value) => {
				if (!isMemberStatusResult(value)) throw new BebopClientError("malformed-response");
				return value.status as WireMemberStatus as unknown as MemberStatus;
			});
		},
		getMemberLastMessage(member, options) {
			validateMember(member);
			return call({ type: "member_last_message_target", target: member }, options, (value) => {
				if (!isMemberLastMessageResult(value)) throw new BebopClientError("malformed-response");
				return value;
			});
		},
		sendFollowUp(member, input, options) {
			validateMember(member);
			validateMessage(input.message);
			validateInstructions(input.instructions);
			validateEffectPayload(input.message, input.instructions, "follow-up");
			return call(
				{
					type: "member_follow_up",
					target: member,
					message: input.message,
					...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
				},
				options,
				(value) => {
					if (!isMemberMessageResult(value)) throw new BebopClientError("malformed-response");
					return {
						member: value.member,
						deliveryId: value.deliveryId,
						disposition: value.disposition,
					};
				},
				true,
			);
		},
		sendToInbox(member, input, options) {
			validateMember(member);
			validateMessage(input.message);
			validateInstructions(input.instructions);
			validateEffectPayload(input.message, input.instructions, "inbox");
			return call(
				{
					type: "member_inbox_send",
					target: member,
					message: input.message,
					...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
				},
				options,
				(value) => {
					if (!isMemberInboxSendResult(value)) throw new BebopClientError("malformed-response");
					return {
						member: value.member,
						itemId: value.itemId,
						persisted: true,
						hint: value.hint,
					};
				},
				true,
			);
		},
	};
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function retainDiscoveryEntry(entries: Map<string, Dirent>, entry: Dirent): void {
	if (entries.has(entry.name)) return;
	if (entries.size < MAX_DISCOVERY_ENTRIES) {
		entries.set(entry.name, entry);
		return;
	}
	let largest: string | undefined;
	for (const name of entries.keys()) {
		if (largest === undefined || compareNames(name, largest) > 0) largest = name;
	}
	if (largest !== undefined && compareNames(entry.name, largest) < 0) {
		entries.delete(largest);
		entries.set(entry.name, entry);
	}
}

async function closeDirectory(directory: Awaited<ReturnType<typeof fs.opendir>>): Promise<void> {
	try {
		await directory.close();
	} catch {
		// The async iterator may already have closed the directory.
	}
}

async function discover(options: BebopOperationOptions | undefined): Promise<readonly BebopSourceInfo[]> {
	return withBudget(options, async (budget) => {
		const entries = new Map<string, Dirent>();
		let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
		let opening: Promise<Awaited<ReturnType<typeof fs.opendir>>> | undefined;
		try {
			opening = fs.opendir(CONTROL_DIR);
			try {
				directory = await awaitBudget(opening, budget);
			} catch (error) {
				void opening.then(closeDirectory, () => undefined);
				throw error;
			}
			const iterator = directory[Symbol.asyncIterator]();
			for (;;) {
				const result = await awaitBudget(iterator.next(), budget);
				if (result.done) break;
				if (budget.signal.aborted) throw budgetAbortReason(budget);
				retainDiscoveryEntry(entries, result.value);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		} finally {
			if (directory !== undefined) {
				const closing = closeDirectory(directory);
				if (!budget.signal.aborted) await awaitBudget(closing, budget);
			}
		}
		const bounded = [...entries.values()].sort((left, right) => compareNames(left.name, right.name));
		const ids = bounded
			.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".sock"))
			.map((entry) => entry.name.slice(0, -5))
			.filter(isSafeSessionId)
			.sort(compareNames)
			.slice(0, MAX_DISCOVERY_SOURCES);
		const aliases = new Map<string, string[]>();
		for (const entry of bounded) {
			if (!entry.isSymbolicLink() || !entry.name.endsWith(".alias")) continue;
			const alias = entry.name.slice(0, -6);
			if (!isSafeAlias(alias)) continue;
			try {
				const endpoint = await aliasSocket(alias, budget);
				const session = path.basename(endpoint).slice(0, -5);
				if (ids.includes(session)) aliases.set(session, [...(aliases.get(session) ?? []), alias]);
			} catch (error) {
				if (budget.signal.aborted) throw error;
				// Stale or unsafe aliases are omitted from public discovery.
			}
		}
		const sources = await Promise.all(
			ids.map(async (session): Promise<BebopSourceInfo> => {
				try {
					const status = await querySource(getSocketPath(session), budget);
					return {
						session,
						aliases: (aliases.get(session) ?? []).sort(compareNames),
						state: status.state,
						trusted: status.trusted,
					};
				} catch (error) {
					if (budget.signal.aborted) throw error;
					return {
						session,
						aliases: (aliases.get(session) ?? []).sort(compareNames),
						state: "unknown",
						trusted: false,
					};
				}
			}),
		);
		return sources.sort((left, right) => compareNames(left.session, right.session));
	});
}

async function select(
	selector: SourceSelector | undefined,
	options: BebopOperationOptions | undefined,
): Promise<BebopSource> {
	const session = selector?.session ?? process.env.PI_SESSION_ID;
	if (session === undefined || session === "") throw new BebopClientError("source-required");
	validateSession(session);
	return withBudget(options, async (budget) => {
		const candidates = await sourceCandidates(session, budget);
		if (candidates.length === 0) throw new BebopClientError("unknown-session");
		let last: BebopClientError | undefined;
		for (const candidate of candidates) {
			try {
				const status = await querySource(candidate, budget);
				if (status.state !== "joined") throw new BebopClientError("not-joined");
				if (!status.trusted) throw new BebopClientError("untrusted");
				return sourceClient(await controlledSocket(candidate, budget));
			} catch (error) {
				const mapped = normalizeError(error, budget);
				last = mapped;
				if (mapped.code !== "unknown-session" && mapped.code !== "offline-session") throw mapped;
			}
		}
		throw last ?? new BebopClientError("unknown-session");
	});
}

export function createBebopClient(): BebopClient {
	return {
		listSources: discover,
		selectSource: select,
	};
}
