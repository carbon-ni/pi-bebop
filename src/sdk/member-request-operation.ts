import { isMemberRequestResult, isMethodResult, type RpcCommand, type RequestOutcome } from "../domain/index.ts";
import { MemberMessageError, type CrewMembership } from "../application/member-message.ts";
import type { MemberRequestFlow } from "../application/member-request-flow.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { BebopClientError, type BebopClientErrorCode } from "./errors.ts";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
} from "../domain/message-payload.ts";

const MAX_TARGET_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 7_210_000;

export interface MemberRequestStartInput {
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly timeoutSeconds?: number;
	readonly maxWaitSeconds?: number;
	/** Required only for an approved Guest source route. */
	readonly crew?: string;
}

export interface MemberRequestStartResult {
	readonly accepted: true;
	readonly requestId: string;
	readonly member: { readonly name: string; readonly role: string };
}

export type MemberRequestWaitResult = RequestOutcome;

export interface MemberRequestResponseInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface MemberRequestOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export type MemberRequestWaitRegistration = ReturnType<
	InProcessMemberRequestFlowCapability["waitForRequestOutcomeById"]
>;

export interface MemberRequestOperation {
	startMemberRequest(
		member: string,
		input: MemberRequestStartInput,
		options?: MemberRequestOperationOptions,
	): Promise<MemberRequestStartResult>;
	waitForRequestOutcome(requestId: string, options?: MemberRequestOperationOptions): Promise<MemberRequestWaitResult>;
	respondToMemberRequest(
		requestId: string | undefined,
		input: MemberRequestResponseInput,
		options?: MemberRequestOperationOptions,
	): Promise<void>;
}

/** In-process-only extension used by the Pi edge to arm the shared wake gate synchronously. */
export interface InProcessMemberRequestOperation extends MemberRequestOperation {
	readonly beginRequestOutcomeWait: (
		requestId: string,
		onUpdate: (outcome: RequestOutcome) => void,
	) => MemberRequestWaitRegistration;
}

export type RemoteMemberRequestStartCommand = Extract<RpcCommand, { type: "member_request_start" }>;
export type RemoteMemberRequestWaitCommand = Extract<RpcCommand, { type: "member_request_wait" }>;
export type RemoteMemberResponseCommand = Extract<RpcCommand, { type: "member_response" }>;

export interface RemoteMemberRequestStartWaitDependencies {
	readonly sendStart: (
		command: RemoteMemberRequestStartCommand,
		options?: MemberRequestOperationOptions,
	) => Promise<unknown>;
	readonly sendWait: (
		command: RemoteMemberRequestWaitCommand,
		options?: MemberRequestOperationOptions,
	) => Promise<unknown>;
}

export interface RemoteMemberRequestOperationDependencies extends RemoteMemberRequestStartWaitDependencies {
	readonly sendResponse: (
		command: RemoteMemberResponseCommand,
		options?: MemberRequestOperationOptions,
	) => Promise<unknown>;
}

export type InProcessMemberRequestFlowCapability = Pick<
	MemberRequestFlow,
	"sendMemberRequest" | "sendGuestMemberRequest" | "waitForRequestOutcomeById" | "respondToMemberRequest"
>;

export interface InProcessGuestRequest {
	readonly crewId: string;
	readonly memberSocket: string;
	readonly target: { readonly name: string; readonly role?: string };
	readonly guestIdentity: string;
	readonly guestName: string;
	readonly callbackEndpoint: string;
	readonly capability: string;
}

export interface InProcessMemberRequestSurface {
	/** Every operation reads current authority; no membership snapshot is retained. */
	readonly getMembership: () => CrewMembership | null;
	readonly isTrusted: () => boolean;
	readonly getMemberRequestFlow: () => InProcessMemberRequestFlowCapability | undefined;
	/** Guest admission and credentials are runtime-owned and checked at start time. */
	readonly getGuestRequest?: (crew: string, target: string) => InProcessGuestRequest | null;
}

export interface InProcessMemberRequestOperationDependencies {
	readonly surface: InProcessMemberRequestSurface;
}

interface OperationBudget {
	readonly signal: AbortSignal;
	readonly timedOut: () => boolean;
	cleanup(): void;
}

function validateOperationOptions(options: MemberRequestOperationOptions | undefined): void {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (
		!Number.isFinite(timeoutMs) ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < MIN_TIMEOUT_MS ||
		timeoutMs > MAX_TIMEOUT_MS
	)
		throw new BebopClientError("invalid-input");
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
}

function createBudget(options: MemberRequestOperationOptions | undefined): OperationBudget {
	validateOperationOptions(options);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	let expired = false;
	const onAbort = () => controller.abort(options?.signal?.reason);
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(new Error("operation timed out"));
	}, timeoutMs);
	return {
		signal: controller.signal,
		timedOut: () => expired,
		cleanup() {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
		},
	};
}

function validateRequestId(requestId: string | undefined): asserts requestId is string {
	if (
		typeof requestId !== "string" ||
		requestId.length === 0 ||
		requestId.trim() !== requestId ||
		Buffer.byteLength(requestId, "utf8") > 128
	)
		throw new BebopClientError("invalid-request-id");
}

function validateStart(member: string, input: MemberRequestStartInput): void {
	if (
		typeof member !== "string" ||
		member.length === 0 ||
		member.trim() !== member ||
		member.includes("\0") ||
		Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES ||
		typeof input?.message !== "string" ||
		input.message.trim().length === 0 ||
		input.message.includes("\0") ||
		Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_CONTENT_BYTES
	)
		throw new BebopClientError("invalid-input");
	validateInstructions(input.instructions);
	if (
		input.timeoutSeconds !== undefined &&
		(!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 600)
	)
		throw new BebopClientError("invalid-input");
	if (
		input.maxWaitSeconds !== undefined &&
		(!Number.isInteger(input.maxWaitSeconds) || input.maxWaitSeconds < 60 || input.maxWaitSeconds > 7200)
	)
		throw new BebopClientError("invalid-input");
	const timeoutSeconds = input.timeoutSeconds ?? 120;
	const maxWaitSeconds = input.maxWaitSeconds ?? 1800;
	if (maxWaitSeconds <= timeoutSeconds) throw new BebopClientError("invalid-input");
	const payload = {
		content: input.message,
		...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
		origin: {
			kind: "crew",
			name: "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES),
			role: "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES),
		},
		kind: "member request",
		sentAt: Number.MAX_SAFE_INTEGER,
	};
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_MESSAGE_PAYLOAD_BYTES)
		throw new BebopClientError("invalid-input");
}

function validateInstructions(instructions: readonly string[] | undefined): void {
	if (instructions === undefined) return;
	if (!Array.isArray(instructions) || instructions.length > MAX_MESSAGE_INSTRUCTIONS)
		throw new BebopClientError("invalid-input");
	for (const instruction of instructions) {
		if (
			typeof instruction !== "string" ||
			instruction.trim().length === 0 ||
			instruction.includes("\0") ||
			Buffer.byteLength(instruction, "utf8") > MAX_MESSAGE_INSTRUCTION_BYTES
		)
			throw new BebopClientError("invalid-input");
	}
}

function validateResponse(input: MemberRequestResponseInput): void {
	if (
		typeof input?.message !== "string" ||
		input.message.trim().length === 0 ||
		input.message.includes("\0") ||
		Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_CONTENT_BYTES
	)
		throw new BebopClientError("invalid-input");
	validateInstructions(input.instructions);
}

export function createRemoteMemberRequestStartWaitOperation(
	dependencies: RemoteMemberRequestStartWaitDependencies,
): Pick<MemberRequestOperation, "startMemberRequest" | "waitForRequestOutcome"> {
	return {
		async startMemberRequest(member, input, options) {
			validateStart(member, input);
			validateOperationOptions(options);
			const result = await runRemote(
				() =>
					dependencies.sendStart(
						{
							type: "member_request_start",
							target: member,
							message: input.message,
							...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
							timeoutSeconds: input.timeoutSeconds ?? 120,
							maxWaitSeconds: input.maxWaitSeconds ?? 1800,
							...(input.crew === undefined ? {} : { crew: input.crew }),
						},
						options,
					),
				"start",
			);
			if (!isMemberRequestResult(result)) throw new BebopClientError("malformed-response");
			return result;
		},
		async waitForRequestOutcome(requestId, options) {
			validateRequestId(requestId);
			validateOperationOptions(options);
			const result = await runRemote(
				() => dependencies.sendWait({ type: "member_request_wait", requestId }, options),
				"wait",
			);
			if (!isMethodResult("member.request_wait", result)) throw new BebopClientError("malformed-response");
			const outcome = result as unknown as RequestOutcome;
			if (outcome.requestId !== requestId) throw new BebopClientError("malformed-response");
			return outcome;
		},
	};
}

export function createRemoteMemberRequestOperation(
	dependencies: RemoteMemberRequestOperationDependencies,
): MemberRequestOperation {
	const startWait = createRemoteMemberRequestStartWaitOperation(dependencies);
	return {
		...startWait,
		async respondToMemberRequest(requestId, input, options) {
			validateRequestId(requestId);
			validateResponse(input);
			validateOperationOptions(options);
			const result = await runRemote(
				() =>
					dependencies.sendResponse(
						{
							type: "member_response",
							requestId,
							message: input.message,
							instructions: input.instructions === undefined ? [] : [...input.instructions],
						},
						options,
					),
				"respond",
			);
			if (!isMethodResult("member.respond", result)) throw new BebopClientError("malformed-response");
		},
	};
}

async function runRemote<T>(operation: () => Promise<T>, kind: "start" | "wait" | "respond"): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw mapRequestError(error, kind);
	}
}

function mapRequestError(error: unknown, kind: "start" | "wait" | "respond"): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (error instanceof RpcProtocolError) {
		if (error.code === "remote-error") return mapRequestCode(error.message.replace(/^remote-error:\s*/, ""));
		if (error.code === "outcome-unknown") return new BebopClientError("outcome-unknown");
		if (error.code === "malformed-response" || error.code === "invalid-result" || error.code === "mismatched-id")
			return new BebopClientError("malformed-response");
		return mapRequestCode(error.code);
	}
	if (error instanceof Error) {
		if (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "aborted")
			return new BebopClientError("aborted");
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "outcome-unknown") return new BebopClientError("outcome-unknown");
		if (code === "ETIMEDOUT" || code === "ETIME" || code === "timeout" || /timeout/i.test(error.message))
			return new BebopClientError("timeout");
		if (code === "ENOENT" || code === "unknown-session") return new BebopClientError("unknown-session");
		if (code === "ECONNREFUSED" || code === "ENOTCONN" || code === "offline-session")
			return new BebopClientError("offline-session");
		if (code === "EPROTOTYPE" || code === "ENOTSOCK" || code === "EPIPE")
			return new BebopClientError("transport-error");
		return mapRequestCode(error.message.trim().split(/[:\s]/u, 1)[0]!, kind);
	}
	return new BebopClientError("transport-error");
}

function mapRequestCode(value: string, kind?: "start" | "wait" | "respond"): BebopClientError {
	const code = value.trim().split(/[:\s]/u, 1)[0];
	const known: Partial<Record<string, BebopClientErrorCode>> = {
		"invalid-request-id": "invalid-request-id",
		"unknown-request": "unknown-request",
		"no-pending-request": "no-pending-request",
		"no-pending-requests": "no-pending-requests",
		"already-waiting": "already-waiting",
		"outcome-consumed": "outcome-consumed",
		"response-expired": "response-expired",
		"ambiguous-request": "ambiguous-request",
		"already-terminal": "already-terminal",
		"duplicate-request": "duplicate-request",
		"invalid-timeout": "invalid-timeout",
		"invalid-max-wait": "invalid-max-wait",
		"outbound-capacity": "capacity-exceeded",
		"inbound-capacity": "capacity-exceeded",
		"buffer-capacity": "capacity-exceeded",
		"not-joined": "not-joined",
		untrusted: "untrusted",
		"untrusted-project": "untrusted",
		"offline-member": "offline-member",
		"offline-session": "offline-session",
		"unknown-member": "unknown-member",
		"ambiguous-member": "ambiguous-member",
		"self-send": "self-send",
		"invalid-payload": "invalid-payload",
		"invalid-input": "invalid-input",
		"coordination-unavailable": "remote-rejected",
		"delivery-failed": "remote-rejected",
		"request-failed": "remote-rejected",
		"response-failed": "remote-rejected",
	};
	return new BebopClientError(known[code] ?? (kind === "wait" ? "remote-rejected" : "remote-rejected"));
}

export function createInProcessMemberRequestOperation(
	dependencies: InProcessMemberRequestOperationDependencies,
): InProcessMemberRequestOperation {
	return {
		beginRequestOutcomeWait(requestId, onUpdate) {
			const flow = dependencies.surface.getMemberRequestFlow();
			if (!flow) return { ok: false, code: "unknown-request" } as const;
			return flow.waitForRequestOutcomeById(requestId, onUpdate);
		},
		async startMemberRequest(member, input, options) {
			validateStart(member, input);
			const budget = createBudget(options);
			try {
				if (!dependencies.surface.isTrusted()) throw new BebopClientError("untrusted");
				const flow = dependencies.surface.getMemberRequestFlow();
				if (!flow) throw new BebopClientError("remote-rejected");
				const membership = dependencies.surface.getMembership();
				const accepted = membership
					? await flow.sendMemberRequest({
							membership,
							member,
							message: input.message,
							instructions: input.instructions,
							timeoutSeconds: input.timeoutSeconds,
							maxWaitSeconds: input.maxWaitSeconds,
							signal: budget.signal,
						})
					: input.crew !== undefined && dependencies.surface.getGuestRequest
						? await startGuest(
								flow,
								dependencies.surface.getGuestRequest(input.crew, member),
								input,
								budget.signal,
							)
						: (() => {
								throw new BebopClientError("not-joined");
							})();
				return {
					accepted: true,
					requestId: accepted.requestId,
					member:
						accepted.member.kind === "member"
							? { name: accepted.member.name, role: accepted.member.role }
							: { name: accepted.member.guestName, role: "guest" },
				};
			} catch (error) {
				throw mapInProcessError(error, budget);
			} finally {
				budget.cleanup();
			}
		},
		async waitForRequestOutcome(requestId, options) {
			validateRequestId(requestId);
			const budget = createBudget(options);
			try {
				const flow = dependencies.surface.getMemberRequestFlow();
				if (!flow) throw new BebopClientError("remote-rejected");
				return await waitInProcess(flow, requestId, budget);
			} finally {
				budget.cleanup();
			}
		},
		async respondToMemberRequest(requestId, input, options) {
			if (requestId !== undefined) validateRequestId(requestId);
			validateResponse(input);
			const budget = createBudget(options);
			try {
				if (!dependencies.surface.isTrusted()) throw new BebopClientError("untrusted");
				const membership = dependencies.surface.getMembership();
				if (!membership) throw new BebopClientError("not-joined");
				const flow = dependencies.surface.getMemberRequestFlow();
				if (!flow) throw new BebopClientError("remote-rejected");
				await awaitWithBudget(
					flow.respondToMemberRequest({
						requestId,
						message: input.message,
						instructions: input.instructions,
						member: { name: membership.member.name, role: membership.member.role },
					}),
					budget,
					"outcome-unknown",
				);
			} catch (error) {
				throw mapInProcessError(error, budget);
			} finally {
				budget.cleanup();
			}
		},
	};
}

async function startGuest(
	flow: InProcessMemberRequestFlowCapability,
	guest: InProcessGuestRequest | null,
	input: MemberRequestStartInput,
	signal: AbortSignal,
) {
	if (!guest) throw new BebopClientError("remote-rejected");
	return flow.sendGuestMemberRequest({
		...guest,
		message: input.message,
		instructions: input.instructions,
		timeoutSeconds: input.timeoutSeconds,
		maxWaitSeconds: input.maxWaitSeconds,
		signal,
	});
}

function awaitWithBudget<T>(
	promise: Promise<T>,
	budget: OperationBudget,
	abortCode: BebopClientErrorCode = budget.timedOut() ? "timeout" : "aborted",
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => budget.signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new BebopClientError(abortCode));
		};
		promise.then(
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
		budget.signal.addEventListener("abort", onAbort, { once: true });
		if (budget.signal.aborted) onAbort();
	});
}

function waitInProcess(
	flow: InProcessMemberRequestFlowCapability,
	requestId: string,
	budget: OperationBudget,
): Promise<RequestOutcome> {
	return new Promise((resolve, reject) => {
		let active = true;
		let cancel: (() => void) | undefined;
		const finish = (callback: () => void) => {
			if (!active) return;
			active = false;
			budget.signal.removeEventListener("abort", onAbort);
			cancel?.();
			callback();
		};
		const onAbort = () => finish(() => reject(new BebopClientError(budget.timedOut() ? "timeout" : "aborted")));
		const waiting = flow.waitForRequestOutcomeById(requestId, (outcome) => finish(() => resolve(outcome)));
		if (waiting.ok === false) {
			finish(() => reject(mapRequestCode(waiting.code)));
			return;
		}
		if (waiting.kind === "update") {
			finish(() => resolve(waiting.update));
			return;
		}
		cancel = waiting.cancel;
		if (budget.signal.aborted) onAbort();
		else budget.signal.addEventListener("abort", onAbort, { once: true });
	});
}

function mapInProcessError(error: unknown, budget: OperationBudget): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (error instanceof MemberMessageError) return mapRequestCode(error.code);
	if (error instanceof RpcProtocolError) return mapRequestError(error, "start");
	if (budget.timedOut()) return new BebopClientError("timeout");
	if (error instanceof Error && error.name === "AbortError") return new BebopClientError("aborted");
	return mapRequestCode(error instanceof Error ? error.message : "remote-rejected");
}
