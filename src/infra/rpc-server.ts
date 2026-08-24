import * as net from "node:net";
import {
	buildErrorResponse,
	buildResultResponse,
	buildTurnEndNotification,
	buildMemberUpdateNotification,
	isMemberIdleWaitNotification,
	parseRequest,
	requestToCommand,
	RPC_ERROR,
	serializeProtocolMessage,
	type RpcInboundCommand,
	type RpcId,
	type RpcCommandResponse,
	type RpcTurnEndNotification,
} from "../domain/index.ts";

export type RpcSocket = Pick<net.Socket, "write" | "once">;
export type RpcServer = Pick<net.Server, "close">;
export type RpcCommandHandler = (command: RpcInboundCommand, socket: RpcSocket) => void | Promise<void>;

function write(socket: RpcSocket, value: Parameters<typeof serializeProtocolMessage>[0]): void {
	try {
		socket.write(serializeProtocolMessage(value));
	} catch {
		/* Socket may be closed. */
	}
}
export function writeWireResponse(socket: RpcSocket, id: RpcId, method: string, result: unknown): void {
	const response = buildResultResponse(id, method, result);
	if ("code" in response) {
		writeWireError(socket, id, response.code, response.message, response.data);
		return;
	}
	write(socket, response);
}
export function writeWireError(
	socket: RpcSocket,
	id: RpcId | null,
	code: number,
	message: string,
	data?: { code?: string },
): void {
	write(socket, buildErrorResponse(id, code, message, data));
}

function methodForCommand(command: string): string | undefined {
	switch (command) {
		case "status":
			return "session.status";
		case "send":
			return "message.send";
		case "interrupt":
			return "message.interrupt";
		case "member_status":
			return "member.status";
		case "member_status_target":
			return "member.status_target";
		case "member_request":
			return "member.request";
		case "member_response":
			return "member.respond";
		case "member_interrupt":
			return "member.interrupt";
		case "member_focus":
			return "member.focus";
		case "member_follow_up":
			return "member.follow_up";
		case "member_redirect":
			return "member.redirect";
		case "member_inbox_send":
			return "member.inbox_send";
		case "crew_broadcast":
			return "crew.broadcast";
		case "member_idle_wait":
			return "member.idle_wait";
		case "get_message":
			return "session.get_message";
		case "clear":
			return "session.clear";
		case "abort":
			return "session.abort";
		case "subscribe":
			return "event.subscribe";
		case "presence_hint":
			return "presence.hint";
		default:
			return undefined;
	}
}
export function writeResponse(socket: RpcSocket, response: RpcCommandResponse): void {
	if (typeof response.id !== "string" && typeof response.id !== "number") {
		writeWireError(socket, null, RPC_ERROR.invalidRequest, "Response requires a correlated request id");
		return;
	}
	const method = methodForCommand(response.command);
	if (!method) {
		writeWireError(socket, response.id, RPC_ERROR.internal, "Unknown command", { code: "unknown-command" });
		return;
	}
	if (response.success) {
		writeWireResponse(socket, response.id, method, response.data);
		return;
	}
	const durableCommand = response.command === "member_inbox_send" || response.command === "crew_broadcast";
	const error = response.error ?? "Internal error";
	writeWireError(socket, response.id, RPC_ERROR.internal, error, durableCommand ? { code: error } : undefined);
}
export function writeEvent(socket: RpcSocket, event: RpcTurnEndNotification): void {
	const notification = buildTurnEndNotification(
		event.subscriptionId,
		event.data?.message ?? null,
		event.data?.turnIndex,
	);
	try {
		write(socket, notification);
	} catch {
		/* Socket may be closed. */
	}
}
export function writeMemberUpdateEvent(
	socket: RpcSocket,
	update: import("../domain/index.ts").MemberUpdateResult,
): void {
	try {
		write(socket, buildMemberUpdateNotification(update));
	} catch {
		/* Socket may be closed. */
	}
}
export function writeMemberIdleWaitEvent(socket: RpcSocket, event: { subscriptionId: string; result: unknown }): void {
	const notification = {
		jsonrpc: "2.0" as const,
		method: "member.idle_wait" as const,
		params: { subscriptionId: event.subscriptionId, result: event.result },
	};
	if (!isMemberIdleWaitNotification(notification)) throw new Error("Invalid member idle wait event");
	write(socket, notification);
}

export async function createRpcServer(socketPath: string, onCommand: RpcCommandHandler): Promise<RpcServer> {
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
					writeWireError(socket, null, parsed.error.code, parsed.error.message, parsed.error.data);
					continue;
				}
				const request = parsed.request!;
				const command = requestToCommand(request);
				if ("code" in command) {
					writeWireError(socket, request.id, command.code, command.message, command.data);
					continue;
				}
				void Promise.resolve(onCommand(command, socket)).catch(() =>
					writeWireError(socket, request.id, RPC_ERROR.internal, "Internal error", {
						code: "internal-error",
					}),
				);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return server;
}
export async function closeRpcServer(server: RpcServer): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
