import {
	MemberMessageError,
	sendMemberMessage,
	type CrewMembership,
	type MemberMessageDependencies,
} from "../application/member-message.ts";
import type { RpcCommand } from "../domain/index.ts";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
} from "../domain/message-payload.ts";
import { isMemberMessageResult } from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { BebopClientError, type BebopClientErrorCode } from "./errors.ts";

export interface FollowUpInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface FollowUpResult {
	readonly member: { readonly name: string; readonly role: string };
	readonly deliveryId: string;
	readonly disposition: "direct" | "steered" | "queued";
}

export interface FollowUpOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface FollowUpOperation {
	sendFollowUp(member: string, input: FollowUpInput, options?: FollowUpOperationOptions): Promise<FollowUpResult>;
}

export type RemoteFollowUpCommand = Extract<RpcCommand, { type: "member_follow_up" }>;

export interface RemoteFollowUpDependencies {
	readonly send: (command: RemoteFollowUpCommand, options?: FollowUpOperationOptions) => Promise<unknown>;
}

export interface InProcessFollowUpSurface {
	/** Read on every call; do not capture membership when composing the adapter. */
	readonly getMembership: () => CrewMembership | null;
	/** Read on every call; trust belongs to the active source runtime. */
	readonly isTrusted: () => boolean;
	/** Read on every call so approved Guest routes cannot outlive their approval. */
	readonly approvedGuests: () => readonly {
		readonly guestName: string;
		readonly guestIdentity: string;
		readonly callbackEndpoint: string;
	}[];
	/** Runtime-derived reply routing metadata; never accepted from public callers. */
	readonly sender?: () => { readonly sessionId: string; readonly sessionName?: string } | undefined;
}

export interface InProcessFollowUpOperationDependencies {
	readonly surface: InProcessFollowUpSurface;
	readonly message: MemberMessageDependencies;
}

const MAX_TARGET_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 60_000;

interface InProcessBudget {
	readonly signal: AbortSignal;
	timedOut(): boolean;
	cleanup(): void;
}

function validateFollowUpTimeout(options: FollowUpOperationOptions | undefined): number {
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

function createInProcessBudget(options: FollowUpOperationOptions | undefined): InProcessBudget {
	const timeoutMs = validateFollowUpTimeout(options);
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
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

export function createRemoteFollowUpOperation(dependencies: RemoteFollowUpDependencies): FollowUpOperation {
	return {
		async sendFollowUp(member, input, options) {
			validateFollowUpTimeout(options);
			validateFollowUpInput(member, input);
			if (options?.signal?.aborted) throw new BebopClientError("aborted");
			const command: RemoteFollowUpCommand = {
				type: "member_follow_up",
				target: member,
				message: input.message,
				...(input.instructions === undefined || input.instructions.length === 0
					? {}
					: { instructions: [...input.instructions] }),
			};
			try {
				const result = await dependencies.send(command, options);
				if (!isMemberMessageResult(result)) throw new BebopClientError("malformed-response");
				return {
					member: result.member,
					deliveryId: result.deliveryId,
					disposition: result.disposition,
				};
			} catch (error) {
				throw mapRemoteFollowUpError(error);
			}
		},
	};
}

export function createInProcessFollowUpOperation(
	dependencies: InProcessFollowUpOperationDependencies,
): FollowUpOperation {
	return {
		async sendFollowUp(member, input, options) {
			validateFollowUpInput(member, input);
			const budget = createInProcessBudget(options);
			try {
				const membership = dependencies.surface.getMembership();
				if (!membership) throw new BebopClientError("not-joined");
				if (!dependencies.surface.isTrusted()) throw new BebopClientError("untrusted");
				const outcome = await sendMemberMessage(
					{
						membership,
						member,
						message: input.message,
						instructions: input.instructions?.length ? input.instructions : undefined,
						intent: "follow_up",
						approvedGuests: dependencies.surface.approvedGuests(),
						sender: dependencies.surface.sender?.(),
						signal: budget.signal,
					},
					dependencies.message,
				);
				return {
					member:
						outcome.target.kind === "member"
							? { name: outcome.target.name, role: outcome.target.role }
							: { name: outcome.target.guestName, role: "guest" },
					deliveryId: outcome.deliveryId,
					disposition: outcome.disposition,
				};
			} catch (error) {
				if (error instanceof BebopClientError) throw error;
				if (budget.timedOut())
					throw new BebopClientError(
						error instanceof MemberMessageError && error.code === "outcome-unknown"
							? "outcome-unknown"
							: "timeout",
					);
				if (error instanceof MemberMessageError) throw mapMemberMessageError(error);
				throw mapTransportError(error);
			} finally {
				budget.cleanup();
			}
		},
	};
}

function validateFollowUpInput(member: string, input: FollowUpInput): void {
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
	const payload = {
		content: input.message,
		...(input.instructions === undefined || input.instructions.length === 0
			? {}
			: { instructions: [...input.instructions] }),
		origin: {
			kind: "crew",
			name: "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES),
			role: "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES),
		},
		kind: "follow-up",
		sentAt: Number.MAX_SAFE_INTEGER,
	};
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_MESSAGE_PAYLOAD_BYTES)
		throw new BebopClientError("invalid-input");
}

function mapRemoteFollowUpError(error: unknown): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (error instanceof RpcProtocolError) {
		if (error.code === "remote-error") return mapRemoteCode(error.message.replace(/^remote-error:\s*/, ""));
		if (error.code === "malformed-response" || error.code === "invalid-result")
			return new BebopClientError("malformed-response");
		if (error.code === "outcome-unknown") return new BebopClientError("outcome-unknown");
		return mapRemoteCode(error.code);
	}
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "aborted" || error.name === "AbortError") return new BebopClientError("aborted");
		if (code === "outcome-unknown") return new BebopClientError("outcome-unknown");
		if (code === "offline-member") return new BebopClientError("offline-member");
		if (code === "ETIMEDOUT" || code === "ETIME" || code === "timeout") return new BebopClientError("timeout");
		if (code === "ENOENT" || code === "unknown-session") return new BebopClientError("unknown-session");
		if (code === "ECONNREFUSED" || code === "ENOTCONN" || code === "offline-session")
			return new BebopClientError("offline-session");
		if (code === "EPROTOTYPE" || code === "ENOTSOCK" || code === "EPIPE")
			return new BebopClientError("transport-error");
		const remoteCode = error.message.trim().split(/[:\s]/u, 1)[0];
		return mapRemoteCode(remoteCode);
	}
	return new BebopClientError("transport-error");
}

function mapRemoteCode(code: string): BebopClientError {
	const known: Partial<Record<string, BebopClientErrorCode>> = {
		"not-joined": "not-joined",
		"unknown-session": "unknown-session",
		"offline-session": "offline-session",
		"offline-member": "offline-member",
		offline: "offline-member",
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

function mapMemberMessageError(error: MemberMessageError): BebopClientError {
	const mapping: Record<MemberMessageError["code"], BebopClientErrorCode> = {
		"not-joined": "not-joined",
		"response-wait-requires-member-request": "invalid-input",
		"unknown-member": "unknown-member",
		"ambiguous-member": "ambiguous-member",
		"self-send": "self-query",
		"invalid-payload": "invalid-input",
		"remote-rejected": "remote-rejected",
		"invalid-ack": "malformed-response",
		"outcome-unknown": "outcome-unknown",
	};
	return new BebopClientError(mapping[error.code], error.message);
}

function mapTransportError(error: unknown): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (error instanceof RpcProtocolError) return mapRemoteFollowUpError(error);
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "outcome-unknown") return new BebopClientError("outcome-unknown");
		if (code === "aborted" || error.name === "AbortError") return new BebopClientError("aborted");
		if (code === "ETIMEDOUT" || code === "ETIME" || code === "timeout") return new BebopClientError("timeout");
		if (code === "ENOENT" || code === "unknown-session") return new BebopClientError("unknown-session");
		if (code === "ECONNREFUSED" || code === "ENOTCONN" || code === "offline-session")
			return new BebopClientError("offline-session");
	}
	return new BebopClientError("transport-error", error instanceof Error ? error.message : undefined);
}
