import * as net from "node:net";
import { isMethodResult, parseRequest, requestToCommand, RPC_ERROR, type RpcCommand, type RpcId, type RpcCommandResponse, type RpcTurnEndNotification } from "../domain/index.ts";

export type RpcSocket = Pick<net.Socket, "write" | "once">;
export type RpcServer = Pick<net.Server, "close">;
export type RpcCommandHandler = (command: RpcCommand, socket: RpcSocket) => void | Promise<void>;

export function writeWireResponse(socket: RpcSocket, id: RpcId, result: unknown): void {
	try { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); } catch { /* Socket may be closed. */ }
}
export function writeWireError(socket: RpcSocket, id: RpcId | null, code: number, message: string, data?: unknown): void {
	try { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } })}\n`); } catch { /* Socket may be closed. */ }
}

/** Adapter for Pi handlers while keeping all wire serialization in this module. */
export function writeResponse(socket: RpcSocket, response: RpcCommandResponse): void {
	if (response.success) {
		const method = { status: "session.status", send: "message.send", get_message: "session.get_message", clear: "session.clear", abort: "session.abort", subscribe: "event.subscribe" }[response.command];
		if (method && !isMethodResult(method, response.data)) { writeWireError(socket, response.id ?? null, RPC_ERROR.internal, "Invalid method result", { code: "invalid-result" }); return; }
		writeWireResponse(socket, response.id ?? "legacy", response.data);
	} else writeWireError(socket, response.id ?? null, RPC_ERROR.internal, response.error ?? "Internal error");
}
export function writeEvent(socket: RpcSocket, event: RpcTurnEndNotification): void {
	try { socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session.turn_end", params: { subscriptionId: event.subscriptionId ?? "", ...(event.data ?? {}) } })}\n`); } catch { /* Socket may be closed. */ }
}

export async function createRpcServer(socketPath: string, onCommand: RpcCommandHandler, onParseError?: () => void | Promise<void>): Promise<RpcServer> {
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;
				const parsed = parseRequest(line);
				if (parsed.error) {
					void onParseError?.();
					writeWireError(socket, null, parsed.error.code, parsed.error.message, parsed.error.data);
					continue;
				}
				const command = requestToCommand(parsed.request!);
				if ("code" in command) {
					writeWireError(socket, parsed.request!.id, command.code, command.message, command.data);
					continue;
				}
				void Promise.resolve(onCommand(command, socket)).catch(() => writeWireError(socket, parsed.request!.id, RPC_ERROR.internal, "Internal error", { code: "internal-error" }));
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
	});
	return server;
}
export async function closeRpcServer(server: RpcServer): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
