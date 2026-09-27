import {
	isCrewBroadcastResult,
	type CrewBroadcastResult as DomainCrewBroadcastResult,
	type CrewBroadcastRpcResult,
	type RpcCommand,
} from "../domain/index.ts";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
} from "../domain/message-payload.ts";
import { submitCrewBroadcast, CrewBroadcastApplicationError } from "../application/crew-broadcast.ts";
import type { BroadcastMessageDependencies, CrewBroadcastRequest } from "../application/crew-broadcast.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { BebopClientError } from "./errors.ts";

export interface CrewBroadcastInput {
	readonly message: string;
	readonly instructions?: readonly string[];
}

export interface CrewBroadcastOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export type CrewBroadcastResult = DomainCrewBroadcastResult;

export interface CrewBroadcastOperation {
	broadcastToCrew(input: CrewBroadcastInput, options?: CrewBroadcastOperationOptions): Promise<CrewBroadcastResult>;
}

export type RemoteCrewBroadcastCommand = Extract<RpcCommand, { type: "crew_broadcast" }>;

export interface RemoteCrewBroadcastDependencies {
	readonly send: (command: RemoteCrewBroadcastCommand, options?: CrewBroadcastOperationOptions) => Promise<unknown>;
}

export interface InProcessCrewBroadcastSurface {
	/** Read on every call; membership and manifest remain runtime-owned. */
	readonly getMembership: () => CrewBroadcastRequest["membership"];
	/** Read on every call; trust is authoritative in the active source runtime. */
	readonly isTrusted: () => boolean;
	/** Read on every call; only currently approved Guests join the fan-out. */
	readonly approvedGuests?: () => NonNullable<CrewBroadcastRequest["approvedGuests"]>;
}

export interface InProcessCrewBroadcastOperationDependencies {
	readonly surface: InProcessCrewBroadcastSurface;
	readonly message: BroadcastMessageDependencies;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 60_000;

interface OperationBudget {
	readonly signal: AbortSignal;
	cleanup(): void;
}

function validateOptions(options: CrewBroadcastOperationOptions | undefined): void {
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

function createOperationBudget(options: CrewBroadcastOperationOptions | undefined): OperationBudget {
	validateOptions(options);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const controller = new AbortController();
	const onAbort = () => controller.abort(options?.signal?.reason);
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("operation timed out")), timeoutMs);
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
		},
	};
}

function validateInput(input: CrewBroadcastInput): void {
	if (
		!input ||
		typeof input.message !== "string" ||
		input.message.trim().length === 0 ||
		input.message.includes("\0") ||
		Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_CONTENT_BYTES
	)
		throw new BebopClientError("invalid-input");

	const instructions = input.instructions;
	if (instructions !== undefined) {
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

	const payload = {
		content: input.message,
		...(instructions === undefined || instructions.length === 0 ? {} : { instructions: [...instructions] }),
		origin: {
			kind: "crew",
			name: "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES),
			role: "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES),
		},
		kind: "broadcast",
		sentAt: Number.MAX_SAFE_INTEGER,
	};
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_MESSAGE_PAYLOAD_BYTES)
		throw new BebopClientError("invalid-input");
}

function rpcCode(error: RpcProtocolError): string {
	return error.message
		.slice(error.code.length + 2)
		.trim()
		.split(/[:\s]/u, 1)[0]!;
}

function mapRemoteError(error: unknown): BebopClientError {
	if (error instanceof BebopClientError) return error;
	const protocolCode =
		error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined;
	const remoteCodeFromMessage =
		error instanceof Error ? /^remote-error:\s*([^:\s]+)/u.exec(error.message)?.[1] : undefined;
	if (
		error instanceof RpcProtocolError ||
		remoteCodeFromMessage ||
		["outcome-unknown", "malformed-response", "invalid-result", "remote-error"].includes(protocolCode ?? "")
	) {
		if (protocolCode === "outcome-unknown") return new BebopClientError("outcome-unknown");
		if (protocolCode === "malformed-response" || protocolCode === "invalid-result")
			return new BebopClientError("malformed-response");
		if (protocolCode === "remote-error" || remoteCodeFromMessage) {
			const code =
				error instanceof RpcProtocolError
					? rpcCode(error)
					: (remoteCodeFromMessage ?? (error as Error).message.trim().split(/[:\s]/u, 1)[0]!);
			const known: Record<string, ConstructorParameters<typeof BebopClientError>[0]> = {
				"not-joined": "not-joined",
				"untrusted-project": "untrusted",
				untrusted: "untrusted",
				"unknown-session": "unknown-session",
				"offline-session": "offline-session",
				"offline-member": "offline-member",
				"unknown-member": "unknown-member",
				"ambiguous-role": "ambiguous-member",
				"unknown-sender": "remote-rejected",
				"invalid-request": "invalid-input",
				aborted: "aborted",
				timeout: "timeout",
				"transport-error": "transport-error",
				"outcome-unknown": "outcome-unknown",
			};
			return new BebopClientError(
				known[code] ?? "remote-rejected",
				error instanceof Error ? error.message : undefined,
			);
		}
	}
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (error.name === "AbortError" || code === "aborted") return new BebopClientError("aborted");
		if (code === "ETIMEDOUT" || code === "ETIME" || code === "timeout") return new BebopClientError("timeout");
		if (code === "ENOENT" || code === "unknown-session") return new BebopClientError("unknown-session");
		if (code === "ECONNREFUSED" || code === "ENOTCONN" || code === "offline-session")
			return new BebopClientError("offline-session");
		if (code === "outcome-unknown") return new BebopClientError("outcome-unknown");
	}
	return new BebopClientError("transport-error", error instanceof Error ? error.message : undefined);
}

function fromWireResult(result: CrewBroadcastRpcResult): CrewBroadcastResult {
	return {
		ok: true,
		dispositions: result.dispositions.map((item) =>
			item.disposition === "delivered"
				? {
						recipientName: item.member,
						recipientRole: item.role,
						disposition: item.disposition,
						deliveryId: item.deliveryId,
					}
				: {
						recipientName: item.member,
						recipientRole: item.role,
						disposition: item.disposition,
						code: item.code,
					},
		),
		summary: result.summary,
	};
}

function remoteNoRecipients(error: unknown): CrewBroadcastResult | undefined {
	if (!(error instanceof RpcProtocolError)) return undefined;
	const code = error.code === "remote-error" ? rpcCode(error) : error.code;
	if (code === "no-recipients" || code === "unknown-sender") return { ok: false, code };
	return undefined;
}

export function createRemoteCrewBroadcastOperation(
	dependencies: RemoteCrewBroadcastDependencies,
): CrewBroadcastOperation {
	return {
		async broadcastToCrew(input, options) {
			validateInput(input);
			validateOptions(options);
			const command: RemoteCrewBroadcastCommand = {
				type: "crew_broadcast",
				message: input.message,
				...(input.instructions === undefined || input.instructions.length === 0
					? {}
					: { instructions: [...input.instructions] }),
			};
			try {
				const result = await dependencies.send(command, options);
				if (!isCrewBroadcastResult(result)) throw new BebopClientError("malformed-response");
				return fromWireResult(result);
			} catch (error) {
				const noRecipients = remoteNoRecipients(error);
				if (noRecipients) return noRecipients;
				throw mapRemoteError(error);
			}
		},
	};
}

export function createInProcessCrewBroadcastOperation(
	dependencies: InProcessCrewBroadcastOperationDependencies,
): CrewBroadcastOperation {
	return {
		async broadcastToCrew(input, options) {
			validateInput(input);
			const budget = createOperationBudget(options);
			try {
				const membership = dependencies.surface.getMembership();
				if (!membership) throw new BebopClientError("not-joined");
				if (!dependencies.surface.isTrusted()) throw new BebopClientError("untrusted");
				return await submitCrewBroadcast(
					{
						membership,
						message: input.message,
						instructions: input.instructions,
						signal: budget.signal,
						approvedGuests: dependencies.surface.approvedGuests?.(),
					},
					dependencies.message,
				);
			} catch (error) {
				if (error instanceof BebopClientError) throw error;
				if (error instanceof CrewBroadcastApplicationError) {
					if (error.code === "not-joined") throw new BebopClientError("not-joined", error.message);
					if (error.code === "invalid-request") throw new BebopClientError("invalid-input", error.message);
					if (error.code === "unknown-sender") return { ok: false, code: "unknown-sender" };
				}
				throw mapRemoteError(error);
			} finally {
				budget.cleanup();
			}
		},
	};
}
