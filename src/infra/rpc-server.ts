import * as net from "node:net";
import { parseCommand, type RpcCommand, type RpcEvent, type RpcResponse } from "../domain/index.ts";

export type RpcSocket = Pick<net.Socket, "write" | "once">;
export type RpcServer = Pick<net.Server, "close">;
export type RpcCommandHandler = (command: RpcCommand, socket: RpcSocket) => void | Promise<void>;

export function writeResponse(socket: RpcSocket, response: RpcResponse): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// Socket may be closed.
	}
}

export function writeEvent(socket: RpcSocket, event: RpcEvent): void {
	try {
		socket.write(`${JSON.stringify(event)}\n`);
	} catch {
		// Socket may be closed.
	}
}

export async function createRpcServer(
	socketPath: string,
	onCommand: RpcCommandHandler,
	onParseError?: () => void | Promise<void>,
): Promise<RpcServer> {
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

				const parsed = parseCommand(line);
				if (parsed.error) {
					void onParseError?.();
					writeResponse(socket, {
						type: "response",
						command: "parse",
						success: false,
						error: `Failed to parse command: ${parsed.error}`,
					});
					continue;
				}

				void onCommand(parsed.command!, socket);
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
