import {
	createInterruptRecoveryPayload,
	isMemberInterruptResult,
	isInterruptResult,
	MemberInterruptError,
	resolveInterruptTarget,
	type CrewManifest,
	type CrewMember,
	type RpcCommand,
	type RpcCommandResponse,
} from "../domain/index.ts";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
} from "../domain/message-payload.ts";
import { BebopClientError, type BebopClientErrorCode } from "./errors.ts";

export interface InterruptInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface InterruptResult {
	readonly member: { readonly name: string; readonly role: string };
	readonly interruptId: string;
	readonly disposition: "interrupt-requested" | "direct";
}

export interface InterruptOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface MemberInterruptOperation {
	interruptMember(
		member: string,
		input: InterruptInput,
		options?: InterruptOperationOptions,
	): Promise<InterruptResult>;
}

export type RemoteMemberInterruptCommand = Extract<RpcCommand, { type: "member_interrupt" }>;
export type InProcessMemberInterruptCommand = Extract<RpcCommand, { type: "interrupt" }>;

export interface RemoteMemberInterruptOperationDependencies {
	readonly send: (command: RemoteMemberInterruptCommand, options?: InterruptOperationOptions) => Promise<unknown>;
}

export interface InProcessMemberInterruptMembership {
	readonly member: CrewMember;
	readonly socketPath: string;
	readonly manifest: CrewManifest;
}

export interface InProcessMemberInterruptSurface {
	/** Read on every call; membership and source identity belong to the active runtime. */
	readonly getMembership: () => InProcessMemberInterruptMembership | null;
	/** Read on every call; a caller-supplied trust value cannot grant authority. */
	readonly isTrusted: () => boolean;
}

export interface InProcessMemberInterruptTransport {
	readonly send: (
		endpoint: string,
		command: InProcessMemberInterruptCommand,
		options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly classifyLostAck: true },
	) => Promise<{ readonly response: RpcCommandResponse }>;
}

export interface InProcessMemberInterruptOperationDependencies {
	readonly surface: InProcessMemberInterruptSurface;
	readonly resolveEndpoint: (socketPath: string) => Promise<string>;
	readonly transport: InProcessMemberInterruptTransport;
	readonly now?: () => number;
}

interface InterruptBudget {
	readonly signal: AbortSignal;
	readonly timedOut: () => boolean;
	cleanup(): void;
}

const MAX_TARGET_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 60_000;

class DeadlineExceeded extends Error {
	constructor() {
		super("Interrupt operation timed out");
		this.name = "DeadlineExceeded";
	}
}

function timeoutFromOptions(options: InterruptOperationOptions | undefined): number {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (
		!Number.isFinite(timeoutMs) ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < MIN_TIMEOUT_MS ||
		timeoutMs > MAX_TIMEOUT_MS
	)
		throw new BebopClientError("invalid-input");
	return timeoutMs;
}

function createBudget(options: InterruptOperationOptions | undefined, timeoutMs: number): InterruptBudget {
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
	const controller = new AbortController();
	let expired = false;
	const onAbort = () => controller.abort(options?.signal?.reason);
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(new DeadlineExceeded());
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

export function createRemoteMemberInterruptOperation(
	dependencies: RemoteMemberInterruptOperationDependencies,
): MemberInterruptOperation {
	return {
		async interruptMember(member, input, options) {
			validateInterruptInput(member, input);
			timeoutFromOptions(options);
			if (options?.signal?.aborted) throw new BebopClientError("aborted");
			const command: RemoteMemberInterruptCommand = {
				type: "member_interrupt",
				target: member,
				message: input.message,
				...(input.instructions === undefined || input.instructions.length === 0
					? {}
					: { instructions: [...input.instructions] }),
			};
			try {
				const result = await dependencies.send(command, options);
				if (!isMemberInterruptResult(result)) throw new BebopClientError("malformed-response");
				if (result.member.name !== member && result.member.role !== member)
					throw new BebopClientError("identity-mismatch");
				return {
					member: result.member,
					interruptId: result.interruptId,
					disposition: result.disposition,
				};
			} catch (error) {
				throw mapRemoteInterruptError(error);
			}
		},
	};
}

export function createInProcessMemberInterruptOperation(
	dependencies: InProcessMemberInterruptOperationDependencies,
): MemberInterruptOperation {
	return {
		async interruptMember(member, input, options) {
			validateInterruptInput(member, input);
			const timeoutMs = timeoutFromOptions(options);
			const budget = createBudget(options, timeoutMs);
			try {
				const membership = dependencies.surface.getMembership();
				if (!membership) throw new BebopClientError("not-joined");
				if (!dependencies.surface.isTrusted()) throw new BebopClientError("untrusted");
				const resolution = resolveInterruptTarget(membership.manifest, membership.member.name, member);
				if (resolution.ok === false) throw mapInterruptResolutionError(resolution.code);
				const request = {
					senderName: membership.member.name,
					targetName: resolution.target.name,
					message: input.message,
					instructions: input.instructions,
					requestedAt: dependencies.now?.() ?? Date.now(),
				};
				const payload = createInterruptRecoveryPayload(membership.member, request);
				const endpoint = await awaitBeforeDispatch(
					dependencies.resolveEndpoint(resolution.target.socketPath),
					budget,
				);
				if (budget.signal.aborted) throw budget.signal.reason ?? new Error("Operation aborted");
				const { response } = await dependencies.transport.send(
					endpoint,
					{ type: "interrupt", payload },
					{ signal: budget.signal, timeoutMs, classifyLostAck: true },
				);
				if (!response.success) throw mapRemoteCode(response.error ?? "remote-rejected");
				if (!isInterruptResult(response.data)) throw new BebopClientError("malformed-response");
				return {
					member: { name: resolution.target.name, role: resolution.target.role },
					interruptId: response.data.interruptId,
					disposition: response.data.disposition,
				};
			} catch (error) {
				throw mapInProcessInterruptError(error, budget);
			} finally {
				budget.cleanup();
			}
		},
	};
}

function awaitBeforeDispatch<T>(operation: Promise<T>, budget: InterruptBudget): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => budget.signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(budget.signal.reason ?? new Error("Operation aborted"));
		};
		budget.signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
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

function validateInterruptInput(member: string, input: InterruptInput): void {
	if (
		typeof member !== "string" ||
		member.length === 0 ||
		member !== member.trim() ||
		member.includes("\0") ||
		Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES ||
		typeof input?.message !== "string" ||
		input.message.length === 0 ||
		input.message.trim().length === 0 ||
		input.message.includes("\0") ||
		Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_CONTENT_BYTES
	)
		throw new BebopClientError("invalid-input");
	if (input.instructions !== undefined) {
		if (!Array.isArray(input.instructions) || input.instructions.length > MAX_MESSAGE_INSTRUCTIONS)
			throw new BebopClientError("invalid-input");
		for (const instruction of input.instructions) {
			if (
				typeof instruction !== "string" ||
				instruction.trim().length === 0 ||
				instruction.includes("\0") ||
				Buffer.byteLength(instruction, "utf8") > MAX_MESSAGE_INSTRUCTION_BYTES
			)
				throw new BebopClientError("invalid-input");
		}
	}
	const origin = "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES);
	const payload = {
		content: input.message,
		...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
		origin: { kind: "crew", name: origin, role: origin },
		kind: "interrupt",
		sentAt: Number.MAX_SAFE_INTEGER,
	};
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_MESSAGE_PAYLOAD_BYTES)
		throw new BebopClientError("invalid-input");
}

function mapInterruptResolutionError(code: string): BebopClientError {
	const mapping: Record<string, BebopClientErrorCode> = {
		"unknown-member": "unknown-member",
		"ambiguous-member": "ambiguous-member",
		"self-interrupt": "self-query",
		"not-a-member": "not-joined",
		"invalid-request": "invalid-input",
		"invalid-payload": "invalid-input",
	};
	return new BebopClientError(mapping[code] ?? "remote-rejected");
}

function mapRemoteInterruptError(error: unknown): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (isRpcProtocolError(error)) {
		if (error.code === "remote-error") return mapRemoteCode(error.message.replace(/^remote-error:\s*/, ""));
		if (["malformed-response", "invalid-result", "mismatched-id", "duplicate-id"].includes(error.code))
			return new BebopClientError("malformed-response");
		if (error.code === "outcome-unknown") return new BebopClientError("outcome-unknown");
		return mapRemoteCode(error.code);
	}
	return mapRemoteCode(errorCode(error));
}

function mapInProcessInterruptError(error: unknown, budget: InterruptBudget): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (error instanceof MemberInterruptError) return mapInterruptResolutionError(error.code);
	if (isRpcProtocolError(error)) return mapRemoteInterruptError(error);
	const code = errorCode(error);
	if (code === "outcome-unknown") return new BebopClientError("outcome-unknown");
	if (budget.timedOut()) return new BebopClientError("timeout");
	if (code === "aborted" || isAbortError(error)) return new BebopClientError("aborted");
	return mapRemoteCode(code);
}

function mapRemoteCode(code: string): BebopClientError {
	const mapping: Partial<Record<string, BebopClientErrorCode>> = {
		"not-joined": "not-joined",
		untrusted: "untrusted",
		"untrusted-project": "untrusted",
		"unknown-member": "unknown-member",
		"ambiguous-member": "ambiguous-member",
		"self-interrupt": "self-query",
		"not-a-member": "not-joined",
		"invalid-request": "invalid-input",
		"invalid-payload": "invalid-input",
		"already-pending": "already-pending",
		"abort-failed": "abort-failed",
		"no-context": "no-context",
		"handoff-failed": "handoff-failed",
		"invalid-ack": "malformed-response",
		"malformed-response": "malformed-response",
		"mismatched-id": "malformed-response",
		"outcome-unknown": "outcome-unknown",
		aborted: "aborted",
		timeout: "timeout",
		offline: "offline-member",
		"offline-member": "offline-member",
		"offline-session": "offline-session",
		"unknown-session": "unknown-session",
		ENOENT: "offline-member",
		ECONNREFUSED: "offline-member",
		ENOTCONN: "offline-member",
		ETIMEDOUT: "timeout",
		ETIME: "timeout",
		"transport-error": "transport-error",
		"remote-rejected": "remote-rejected",
	};
	return new BebopClientError(mapping[code] ?? "transport-error");
}

function isRpcProtocolError(error: unknown): error is Error & { readonly code: string } {
	return (
		error instanceof Error &&
		error.name === "RpcProtocolError" &&
		typeof (error as NodeJS.ErrnoException).code === "string"
	);
}

function errorCode(error: unknown): string {
	if (!(error instanceof Error)) return "transport-error";
	if (isAbortError(error)) return "aborted";
	const code = (error as NodeJS.ErrnoException).code;
	if (typeof code === "string") return code;
	if (/timed? ?out|timeout/i.test(error.message)) return "timeout";
	return "transport-error";
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
