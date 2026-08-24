import * as net from "node:net";
import { randomUUID } from "node:crypto";
import {
	commandToRequest,
	isMemberIdleWaitNotification,
	isMemberUpdateNotification,
	isMemberRequestResult,
	isMemberIdleWaitSubscribeResult,
	isMethodResult,
	isRpcResponse,
	isSubscribeResult,
	isTurnEndNotification,
	serializeRequest,
	type ExtractedMessage,
	type MemberIdleWaitCommand,
	type MemberIdleWaitResult,
	type MemberRequestCommand,
	type RpcCommand,
	type RpcCommandResponse,
	type RpcId,
	type RpcWireResponse,
} from "../domain/index.ts";

export interface RpcClientOptions {
	timeout?: number;
	waitForEvent?: "turn_end";
	signal?: AbortSignal;
	/** Member-message delivery requires conservative lost-ack classification. */
	classifyLostAck?: boolean;
}

export type MemberIdleWaitClientOutcome =
	| { readonly ok: true; readonly result: MemberIdleWaitResult }
	| {
			readonly ok: false;
			readonly code:
				| "timeout"
				| "offline"
				| "aborted"
				| "malformed-response"
				| "remote-rejected"
				| "capacity-exceeded"
				| "transport-error";
			readonly transportCode?: "ENOENT" | "ECONNREFUSED" | "ENOTCONN";
	  };

export interface MemberIdleWaitClientOptions {
	timeoutSeconds: number;
	signal?: AbortSignal;
}
export class RpcProtocolError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "RpcProtocolError";
		this.code = code;
	}
}
function getAbortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string" && reason.length > 0) return new Error(reason);
	return new Error("Operation aborted");
}
function nextId(): string {
	return `rpc_${randomUUID()}`;
}
function commandResponse(command: string, wire: RpcWireResponse): RpcCommandResponse {
	if ("error" in wire) return { type: "response", command, success: false, error: wire.error.message, id: wire.id };
	return { type: "response", command, success: true, data: wire.result, id: wire.id };
}

export async function sendRpcCommand(
	socketPath: string,
	command: RpcCommand,
	options: RpcClientOptions = {},
): Promise<{ response: RpcCommandResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }> {
	const { timeout = 5000, waitForEvent, signal, classifyLostAck = false } = options;
	const requestId = command.id ?? nextId();
	const request = commandToRequest(command, requestId);
	const subscriptionId = nextId();
	const subscribeRequest =
		waitForEvent === "turn_end"
			? commandToRequest({ type: "subscribe", event: "turn_end", id: subscriptionId }, subscriptionId)
			: undefined;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(getAbortError(signal));
			return;
		}
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let primaryResponse: RpcCommandResponse | null = null;
		let subscriptionAcknowledged = false;
		let settled = false;
		let dispatched = false;
		let timeoutHandle: NodeJS.Timeout;
		const seenIds = new Set<RpcId>();
		const cleanup = () => {
			clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
		};
		const settle = (
			error?: Error,
			result?: { response: RpcCommandResponse; event?: { message?: ExtractedMessage; turnIndex?: number } },
		) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			error ? reject(error) : resolve(result!);
		};
		const outcomeUnknown = () =>
			new RpcProtocolError(
				"outcome-unknown",
				"Delivery outcome unknown: the request was dispatched but its acknowledgement was lost",
			);
		const onAbort = () => settle(classifyLostAck && dispatched ? outcomeUnknown() : getAbortError(signal!));
		signal?.addEventListener("abort", onAbort, { once: true });
		timeoutHandle = setTimeout(
			() => settle(classifyLostAck && dispatched ? outcomeUnknown() : new Error("RPC request timeout")),
			timeout,
		);
		socket.on("connect", () => {
			try {
				socket.write(serializeRequest(request));
				dispatched = true;
				if (subscribeRequest) socket.write(serializeRequest(subscribeRequest));
			} catch (error) {
				settle(error instanceof Error ? error : new Error("Failed to write RPC request"));
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					settle(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response"));
					return;
				}
				if (isTurnEndNotification(value)) {
					if (!waitForEvent || value.params.subscriptionId !== subscriptionId) {
						settle(new RpcProtocolError("unexpected-notification", "Unexpected JSON-RPC notification"));
						return;
					}
					if (!subscriptionAcknowledged) {
						settle(
							new RpcProtocolError(
								"out-of-order-ack",
								"Notification arrived before subscription acknowledgement",
							),
						);
						return;
					}
					if (!primaryResponse) {
						settle(
							new RpcProtocolError(
								"out-of-order-response",
								"Notification arrived before primary response",
							),
						);
						return;
					}
					settle(undefined, {
						response: primaryResponse,
						event: { message: value.params.message ?? undefined, turnIndex: value.params.turnIndex },
					});
					return;
				}
				if (!isRpcResponse(value)) {
					settle(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response envelope"));
					return;
				}
				if (
					value.id === null ||
					(value.id !== requestId && (!subscribeRequest || value.id !== subscriptionId))
				) {
					settle(new RpcProtocolError("mismatched-id", "JSON-RPC response id did not match request"));
					return;
				}
				if (seenIds.has(value.id)) {
					settle(new RpcProtocolError("duplicate-id", "Duplicate JSON-RPC response id"));
					return;
				}
				seenIds.add(value.id);
				const isPrimary = value.id === requestId;
				if ("error" in value) {
					settle(new RpcProtocolError(value.error.data?.code ?? "remote-error", value.error.message));
					return;
				}
				const method = isPrimary ? request.method : "event.subscribe";
				if (!isMethodResult(method, value.result)) {
					settle(new RpcProtocolError("invalid-result", "Invalid JSON-RPC method result"));
					return;
				}
				if (isPrimary) {
					primaryResponse = commandResponse(command.type, value);
					if (!primaryResponse.success) {
						settle(new RpcProtocolError("remote-error", primaryResponse.error ?? "Remote request failed"));
						return;
					}
					if (!waitForEvent) {
						settle(undefined, { response: primaryResponse });
						return;
					}
				} else {
					if (!isSubscribeResult(value.result) || value.result.subscriptionId !== subscriptionId) {
						settle(
							new RpcProtocolError(
								"mismatched-subscription-id",
								"Subscription acknowledgement id did not match request",
							),
						);
						return;
					}
					subscriptionAcknowledged = true;
				}
			}
		});
		socket.on("error", (error) => settle(classifyLostAck && dispatched ? outcomeUnknown() : error));
		socket.on("end", () =>
			settle(classifyLostAck && dispatched ? outcomeUnknown() : new Error("Socket ended before RPC completed")),
		);
		socket.on("close", () =>
			settle(classifyLostAck && dispatched ? outcomeUnknown() : new Error("Socket closed before RPC completed")),
		);
	});
}

/**
 * One-shot member idle wait (TASK-0051). Sends `member.idle_wait`, correlates
 * the subscription ack, and waits for the terminal `member.idle_wait` event.
 * No polling: the caller blocks once, event-driven. The deadline is
 * caller-enforced; on expiry the socket is closed (removing the remote
 * subscription) and `timeout` is returned. Disconnect/restart before a
 * terminal event returns `offline`; caller cancellation returns `aborted`.
 * Malformed online peer output is a protocol error.
 */
export async function sendMemberIdleWait(
	socketPath: string,
	command: MemberIdleWaitCommand,
	options: MemberIdleWaitClientOptions,
): Promise<MemberIdleWaitClientOutcome> {
	const { timeoutSeconds, signal } = options;
	const requestId = command.id ?? nextId();
	const request = commandToRequest(command, requestId);
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ ok: false, code: "aborted" });
			return;
		}
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let settled = false;
		let subscriptionAcknowledged = false;
		let terminalReceived = false;
		let timeoutHandle: NodeJS.Timeout;
		const cleanup = () => {
			clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
		};
		const finish = (outcome: MemberIdleWaitClientOutcome) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			resolve(outcome);
		};
		const onAbort = () => finish({ ok: false, code: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
		timeoutHandle = setTimeout(() => finish({ ok: false, code: "timeout" }), timeoutSeconds * 1000);
		socket.on("connect", () => {
			try {
				socket.write(serializeRequest(request));
			} catch {
				finish({ ok: false, code: "transport-error" });
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				if (isMemberIdleWaitNotification(value)) {
					if (value.params.subscriptionId !== requestId || !subscriptionAcknowledged) {
						finish({ ok: false, code: "malformed-response" });
						return;
					}
					terminalReceived = true;
					finish({ ok: true, result: value.params.result });
					return;
				}
				if (!isRpcResponse(value)) {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				if (value.id !== requestId) {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				if ("error" in value) {
					const message = String(value.error.message ?? "");
					const code = /capacity/i.test(message)
						? "capacity-exceeded"
						: /not-joined|unknown|ambiguous|self-wait/i.test(message)
							? "remote-rejected"
							: "remote-rejected";
					finish({ ok: false, code });
					return;
				}
				if (!isMemberIdleWaitSubscribeResult(value.result)) {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				subscriptionAcknowledged = true;
			}
		});
		socket.on("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTCONN")
				finish({ ok: false, code: "transport-error", transportCode: code });
			else finish({ ok: false, code: "transport-error" });
		});
		socket.on("end", () => finish({ ok: false, code: "offline" }));
		socket.on("close", () => {
			if (!settled && !terminalReceived) finish({ ok: false, code: "offline" });
		});
	});
}

export interface MemberRequestClientOptions {
	timeout?: number;
	signal?: AbortSignal;
	onUpdate: (update: import("../domain/index.ts").MemberUpdateResult) => void;
}

/** Opens the request-scoped channel: the promise resolves at accepted delivery,
 * while the socket remains open for exactly one terminal member.update event. */
export async function sendMemberRequest(
	socketPath: string,
	command: MemberRequestCommand,
	options: MemberRequestClientOptions,
): Promise<{ response: RpcCommandResponse; close: () => void }> {
	const requestId = command.id ?? nextId();
	const request = commandToRequest(command, requestId);
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(getAbortError(options.signal));
			return;
		}
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let settled = false;
		let accepted = false;
		let dispatched = false;
		let closed = false;
		let timeoutHandle: NodeJS.Timeout;
		const cleanup = () => {
			clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
		};
		const close = () => {
			if (closed) return;
			closed = true;
			cleanup();
			socket.destroy();
		};
		const finishBeforeAccept = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onAbort = () => {
			if (accepted) {
				onTerminalClose();
				return;
			}
			finishBeforeAccept(getAbortError(options.signal!));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		timeoutHandle = setTimeout(() => finishBeforeAccept(new Error("RPC request timeout")), options.timeout ?? 5000);
		socket.on("connect", () => {
			try {
				socket.write(serializeRequest(request));
				dispatched = true;
			} catch (error) {
				finishBeforeAccept(error instanceof Error ? error : new Error("Failed to write RPC request"));
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					finishBeforeAccept(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response"));
					return;
				}
				if (isMemberUpdateNotification(value)) {
					if (!accepted) {
						finishBeforeAccept(
							new RpcProtocolError("out-of-order-update", "Update arrived before acceptance"),
						);
						return;
					}
					options.onUpdate(value.params);
					continue;
				}
				if (!isRpcResponse(value) || value.id !== requestId) {
					finishBeforeAccept(
						new RpcProtocolError("mismatched-id", "JSON-RPC response id did not match request"),
					);
					return;
				}
				if ("error" in value) {
					finishBeforeAccept(
						new RpcProtocolError(value.error.data?.code ?? "remote-error", value.error.message),
					);
					return;
				}
				if (!isMethodResult(request.method, value.result) || !isMemberRequestResult(value.result)) {
					finishBeforeAccept(new RpcProtocolError("invalid-result", "Invalid member.request result"));
					return;
				}
				if (settled) {
					finishBeforeAccept(new RpcProtocolError("duplicate-id", "Duplicate JSON-RPC response id"));
					return;
				}
				settled = true;
				accepted = true;
				clearTimeout(timeoutHandle);
				resolve({ response: commandResponse(command.type, value), close });
			}
		});
		const onTerminalClose = () => {
			if (!accepted || closed) return;
			closed = true;
			cleanup();
			socket.destroy();
			options.onUpdate({
				kind: "offline",
				requestId: command.requestId,
				member: {
					name: command.payload.origin?.kind === "crew" ? command.payload.origin.name : "member",
					role: command.payload.origin?.kind === "crew" ? command.payload.origin.role : "member",
				},
			});
		};
		const lostAcknowledgement = () =>
			new RpcProtocolError(
				"outcome-unknown",
				"Delivery outcome unknown: request dispatch acknowledgement was lost",
			);
		socket.on("error", (error) =>
			accepted ? onTerminalClose() : finishBeforeAccept(dispatched ? lostAcknowledgement() : error),
		);
		socket.on("end", () =>
			accepted
				? onTerminalClose()
				: finishBeforeAccept(dispatched ? lostAcknowledgement() : new Error("Socket ended before acceptance")),
		);
		socket.on("close", () =>
			accepted
				? onTerminalClose()
				: finishBeforeAccept(dispatched ? lostAcknowledgement() : new Error("Socket closed before acceptance")),
		);
	});
}
