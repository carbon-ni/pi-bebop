import {
	enqueueMemberInboxMessage,
	MemberInboxMessageError,
	type MemberInboxMessageDependencies,
	type MemberInboxMessageRequest,
} from "../application/member-inbox-message.ts";
import { isMemberInboxSendResult, type RpcCommand } from "../domain/index.ts";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
} from "../domain/message-payload.ts";
import { BebopClientError, type BebopClientErrorCode } from "./errors.ts";

export interface InboxInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface InboxResult {
	readonly member: { readonly name: string; readonly role: string };
	readonly itemId: string;
	readonly persisted: true;
	readonly hint: "sent" | "skipped";
}

export interface InboxOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface MemberInboxOperation {
	sendToInbox(member: string, input: InboxInput, options?: InboxOperationOptions): Promise<InboxResult>;
}

export type RemoteMemberInboxCommand = Extract<RpcCommand, { type: "member_inbox_send" }>;

export interface RemoteMemberInboxOperationDependencies {
	readonly send: (command: RemoteMemberInboxCommand, options?: InboxOperationOptions) => Promise<unknown>;
}

export interface InProcessMemberInboxSurface {
	/** Runtime membership is read for every enqueue; callers cannot supply source identity. */
	readonly getMembership: () => MemberInboxMessageRequest["membership"];
	/** Trust remains owned by the active runtime and is read by the application operation. */
	readonly isTrusted: () => boolean;
}

export interface InProcessMemberInboxOperationDependencies {
	readonly surface: InProcessMemberInboxSurface;
	/** Existing store and hint adapters; this operation never owns Inbox storage. */
	readonly message: Omit<MemberInboxMessageDependencies, "isProjectTrusted" | "beforeEnqueue">;
	readonly now?: () => number;
}

interface Budget {
	readonly signal: AbortSignal;
	readonly timedOut: () => boolean;
	cleanup(): void;
}

const MAX_TARGET_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 60_000;

class DeadlineExceeded extends Error {
	constructor() {
		super("Inbox operation timed out");
		this.name = "DeadlineExceeded";
	}
}

function createBudget(options: InboxOperationOptions | undefined): Budget {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (
		!Number.isFinite(timeoutMs) ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < MIN_TIMEOUT_MS ||
		timeoutMs > MAX_TIMEOUT_MS
	)
		throw new BebopClientError("invalid-input");
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

/** Race non-abortable storage promises without leaving rejection handlers behind. */
function awaitBudget<T>(operation: PromiseLike<T>, budget: Budget): Promise<T> {
	const pending = Promise.resolve(operation);
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

export function createRemoteMemberInboxOperation(
	dependencies: RemoteMemberInboxOperationDependencies,
): MemberInboxOperation {
	return {
		async sendToInbox(member, input, options) {
			validateInboxInput(member, input);
			if (options?.signal?.aborted) throw new BebopClientError("aborted");
			const command: RemoteMemberInboxCommand = {
				type: "member_inbox_send",
				target: member,
				message: input.message,
				...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
			};
			try {
				const result = await dependencies.send(command, options);
				if (!isMemberInboxSendResult(result)) throw new BebopClientError("malformed-response");
				return {
					member: result.member,
					itemId: result.itemId,
					persisted: true,
					hint: result.hint,
				};
			} catch (error) {
				throw mapRemoteInboxError(error);
			}
		},
	};
}

export function createInProcessMemberInboxOperation(
	dependencies: InProcessMemberInboxOperationDependencies,
): MemberInboxOperation {
	return {
		async sendToInbox(member, input, options) {
			validateInboxInput(member, input);
			const budget = createBudget(options);
			let enqueueDispatched = false;
			try {
				const operation = enqueueMemberInboxMessage(
					{
						membership: dependencies.surface.getMembership(),
						member,
						message: input.message,
						...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
						now: dependencies.now?.() ?? Date.now(),
						signal: budget.signal,
					},
					{
						...dependencies.message,
						isProjectTrusted: dependencies.surface.isTrusted,
						beforeEnqueue: () => {
							enqueueDispatched = true;
						},
					},
				);
				const result = await awaitBudget(operation, budget);
				return {
					member: { name: result.target.name, role: result.target.role },
					itemId: result.itemId,
					persisted: true,
					hint: result.hint,
				};
			} catch (error) {
				throw mapInProcessInboxError(error, budget, enqueueDispatched);
			} finally {
				budget.cleanup();
			}
		},
	};
}

function validateInboxInput(member: string, input: InboxInput): void {
	if (!isValidTarget(member)) throw new BebopClientError("invalid-input");
	if (!isValidContent(input?.message)) throw new BebopClientError("invalid-input");
	if (!areInstructionsValid(input.instructions)) throw new BebopClientError("invalid-input");
	if (!fitsAggregatePayload(input.message, input.instructions)) throw new BebopClientError("invalid-input");
}

function isValidTarget(member: string): boolean {
	return (
		typeof member === "string" &&
		member.length > 0 &&
		member === member.trim() &&
		!member.includes("\0") &&
		Buffer.byteLength(member, "utf8") <= MAX_TARGET_BYTES
	);
}

function isValidContent(message: string): boolean {
	return (
		typeof message === "string" &&
		message.length > 0 &&
		message.trim().length > 0 &&
		!message.includes("\0") &&
		Buffer.byteLength(message, "utf8") <= MAX_MESSAGE_CONTENT_BYTES
	);
}

function areInstructionsValid(instructions: readonly string[] | undefined): boolean {
	if (instructions === undefined) return true;
	if (!Array.isArray(instructions) || instructions.length > MAX_MESSAGE_INSTRUCTIONS) return false;
	return instructions.every(
		(instruction) =>
			typeof instruction === "string" &&
			instruction.length > 0 &&
			instruction === instruction.trim() &&
			!instruction.includes("\0") &&
			Buffer.byteLength(instruction, "utf8") <= MAX_MESSAGE_INSTRUCTION_BYTES,
	);
}

function fitsAggregatePayload(message: string, instructions: readonly string[] | undefined): boolean {
	const originField = "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES);
	const payload = {
		content: message,
		...(instructions === undefined ? {} : { instructions: [...instructions] }),
		origin: { kind: "crew", name: originField, role: originField },
		kind: "inbox",
		sentAt: Number.MAX_SAFE_INTEGER,
	};
	return Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_MESSAGE_PAYLOAD_BYTES;
}

function mapApplicationInboxError(error: MemberInboxMessageError): BebopClientError {
	const map: Record<MemberInboxMessageError["code"], BebopClientErrorCode> = {
		"unknown-member": "unknown-member",
		"ambiguous-role": "ambiguous-role",
		"self-send": "self-send",
		"not-joined": "not-joined",
		"invalid-payload": "invalid-payload",
		"untrusted-project": "untrusted-project",
		"inbox-full": "inbox-full",
		"inbox-untrusted-path": "inbox-untrusted-path",
		"storage-unavailable": "storage-unavailable",
		"storage-failed": "storage-failed",
	};
	return new BebopClientError(map[error.code], error.message);
}

function mapInProcessInboxError(error: unknown, budget: Budget, enqueueDispatched: boolean): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (error instanceof MemberInboxMessageError) return mapApplicationInboxError(error);
	if (budget.signal.aborted || budget.timedOut()) {
		if (enqueueDispatched) return new BebopClientError("outcome-unknown");
		return new BebopClientError(budget.timedOut() ? "timeout" : "aborted");
	}
	if (error instanceof Error && error.name === "AbortError")
		return new BebopClientError(enqueueDispatched ? "outcome-unknown" : "aborted");
	return new BebopClientError("storage-failed");
}

function mapRemoteInboxError(error: unknown): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (isRpcProtocolError(error)) return mapRpcProtocolError(error);
	if (error instanceof Error && error.name === "AbortError") return new BebopClientError("aborted");
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return new BebopClientError("unknown-session");
	if (isOfflineCode(code)) return new BebopClientError("offline-session");
	if (error instanceof Error && /timeout|timed? ?out/i.test(error.message)) return new BebopClientError("timeout");
	return new BebopClientError("transport-error");
}

function isRpcProtocolError(error: unknown): error is Error & { readonly code: string } {
	return (
		error instanceof Error &&
		error.name === "RpcProtocolError" &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

function mapRpcProtocolError(error: Error & { readonly code: string }): BebopClientError {
	if (error.code === "outcome-unknown") return new BebopClientError("outcome-unknown");
	if (["malformed-response", "invalid-result", "mismatched-id"].includes(error.code))
		return new BebopClientError("malformed-response");
	if (error.code === "remote-error") return mapInboxErrorCode(error.message.replace(/^remote-error:\s*/, ""));
	return mapInboxErrorCode(error.code);
}

function isOfflineCode(code: string | undefined): boolean {
	return ["ECONNREFUSED", "ENOTCONN", "EPROTOTYPE", "ENOTSOCK"].includes(code ?? "");
}

function mapInboxErrorCode(value: string): BebopClientError {
	const code = value.trim().split(/[:\s]/u, 1)[0];
	const known: Partial<Record<string, BebopClientErrorCode>> = {
		"unknown-member": "unknown-member",
		"ambiguous-role": "ambiguous-role",
		"self-send": "self-send",
		"not-joined": "not-joined",
		"invalid-payload": "invalid-payload",
		"untrusted-project": "untrusted-project",
		"inbox-full": "inbox-full",
		"inbox-untrusted-path": "inbox-untrusted-path",
		"storage-unavailable": "storage-unavailable",
		"storage-failed": "storage-failed",
		aborted: "aborted",
		"outcome-unknown": "outcome-unknown",
		"unknown-session": "unknown-session",
		"offline-session": "offline-session",
		timeout: "timeout",
		"malformed-response": "malformed-response",
	};
	return new BebopClientError(known[code] ?? "remote-rejected");
}
