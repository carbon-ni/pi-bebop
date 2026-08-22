import * as net from "node:net";
import { commandToRequest, isMethodResult, isRpcResponse, isTurnEndNotification, type ExtractedMessage, type RpcCommand, type RpcCommandResponse, type RpcId, type RpcSubscribeCommand } from "../domain/index.ts";

export interface RpcClientOptions { timeout?: number; waitForEvent?: "turn_end"; signal?: AbortSignal; }
export class RpcProtocolError extends Error { readonly code: string; constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "RpcProtocolError"; this.code = code; } }
function getAbortError(signal: AbortSignal): Error { const reason = signal.reason; if (reason instanceof Error) return reason; if (typeof reason === "string" && reason.length > 0) return new Error(reason); return new Error("Operation aborted"); }
function id(): string { return `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
function commandResponse(command: string, wire: any): RpcCommandResponse {
	if ("error" in wire) return { type: "response", command, success: false, error: wire.error.message, id: wire.id };
	return { type: "response", command, success: true, data: wire.result, id: wire.id };
}

export async function sendRpcCommand(socketPath: string, command: RpcCommand, options: RpcClientOptions = {}): Promise<{ response: RpcCommandResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }> {
	const { timeout = 5000, waitForEvent, signal } = options;
	const requestId = command.id ?? id();
	const request = commandToRequest(command, requestId);
	const subscriptionId = id();
	const subscribeRequest = waitForEvent === "turn_end" ? commandToRequest({ type: "subscribe", event: "turn_end", id: subscriptionId } as RpcSubscribeCommand, subscriptionId) : undefined;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(getAbortError(signal)); return; }
		const socket = net.createConnection(socketPath); socket.setEncoding("utf8");
		let buffer = ""; let response: RpcCommandResponse | null = null; let settled = false; let timeoutHandle: NodeJS.Timeout; const seenIds = new Set<RpcId>();
		const cleanup = () => { clearTimeout(timeoutHandle); signal?.removeEventListener("abort", onAbort); socket.removeAllListeners(); };
		const settle = (error?: Error, result?: { response: RpcCommandResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }) => { if (settled) return; settled = true; cleanup(); socket.destroy(); error ? reject(error) : resolve(result!); };
		const onAbort = () => settle(getAbortError(signal!)); signal?.addEventListener("abort", onAbort, { once: true });
		timeoutHandle = setTimeout(() => settle(new Error("RPC request timeout")), timeout);
		socket.on("connect", () => { try { socket.write(`${JSON.stringify(request)}\n`); if (subscribeRequest) socket.write(`${JSON.stringify(subscribeRequest)}\n`); } catch (error) { settle(error instanceof Error ? error : new Error("Failed to write RPC request")); } });
		socket.on("data", (chunk) => {
			buffer += chunk; let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim(); buffer = buffer.slice(newlineIndex + 1); newlineIndex = buffer.indexOf("\n"); if (!line) continue;
				let value: unknown; try { value = JSON.parse(line); } catch { settle(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response")); return; }
				if (isTurnEndNotification(value)) {
					if (!waitForEvent || value.params.subscriptionId !== subscriptionId) { settle(new RpcProtocolError("unexpected-notification", "Unexpected JSON-RPC notification")); return; }
					if (!response) { settle(new RpcProtocolError("out-of-order-response", "Notification arrived before response")); return; }
					settle(undefined, { response, event: { message: value.params.message as ExtractedMessage | undefined, turnIndex: value.params.turnIndex } }); return;
				}
				if (!isRpcResponse(value)) { settle(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response envelope")); return; }
				if (value.id !== requestId && (!subscribeRequest || value.id !== subscriptionId)) { settle(new RpcProtocolError("mismatched-id", "JSON-RPC response id did not match request")); return; }
				if (seenIds.has(value.id as RpcId)) { settle(new RpcProtocolError("duplicate-id", "Duplicate JSON-RPC response id")); return; }
				seenIds.add(value.id as RpcId);
				if (!("error" in value) && !isMethodResult(value.id === requestId ? request.method : "event.subscribe", value.result)) { settle(new RpcProtocolError("invalid-result", "Invalid JSON-RPC method result")); return; }
				if (value.id === requestId) {
					response = commandResponse(command.type, value);
					if (!response.success) { settle(new RpcProtocolError("remote-error", response.error ?? "Remote request failed")); return; }
					if (!waitForEvent) { settle(undefined, { response }); return; }
				} else if ("error" in value) { settle(new RpcProtocolError("remote-error", value.error.message)); return; }
			}
		});
		socket.on("error", (error) => settle(error)); socket.on("end", () => settle(new Error("Socket ended before RPC completed"))); socket.on("close", () => settle(new Error("Socket closed before RPC completed")));
	});
}
