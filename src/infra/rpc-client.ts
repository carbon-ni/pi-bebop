import * as net from "node:net";
import type { ExtractedMessage, RpcCommand, RpcResponse, RpcSubscribeCommand } from "../domain/index.ts";

export interface RpcClientOptions {
	timeout?: number;
	waitForEvent?: "turn_end";
	signal?: AbortSignal;
}

function getAbortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string" && reason.length > 0) return new Error(reason);
	return new Error("Operation aborted");
}

export async function sendRpcCommand(
	socketPath: string,
	command: RpcCommand,
	options: RpcClientOptions = {},
): Promise<{ response: RpcResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }> {
	const { timeout = 5000, waitForEvent, signal } = options;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(getAbortError(signal));
			return;
		}

		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");

		let buffer = "";
		let response: RpcResponse | null = null;
		let settled = false;
		let timeoutHandle: NodeJS.Timeout;

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
		};

		const settle = (error?: Error, result?: { response: RpcResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			if (error) {
				reject(error);
				return;
			}
			resolve(result!);
		};

		const onAbort = () => settle(getAbortError(signal!));
		signal?.addEventListener("abort", onAbort, { once: true });

		timeoutHandle = setTimeout(() => settle(new Error("RPC request timeout")), timeout);

		socket.on("connect", () => {
			try {
				socket.write(`${JSON.stringify(command)}\n`);

				// If waiting for turn_end, also subscribe.
				if (waitForEvent === "turn_end") {
					const subscribeCmd: RpcSubscribeCommand = { type: "subscribe", event: "turn_end" };
					socket.write(`${JSON.stringify(subscribeCmd)}\n`);
				}
			} catch (error) {
				settle(error instanceof Error ? error : new Error("Failed to write RPC command"));
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

				try {
					const msg = JSON.parse(line) as RpcResponse | { type: "event"; event: string; data?: unknown };

					if (msg.type === "response") {
						if (msg.command === command.type) {
							response = msg;
							if (!response.success) {
								settle(new Error(response.error ?? `RPC ${command.type} failed`));
								return;
							}
							if (!waitForEvent) {
								settle(undefined, { response });
								return;
							}
						} else if (waitForEvent === "turn_end" && msg.command === "subscribe" && !msg.success) {
							settle(new Error(msg.error ?? "Failed to subscribe to turn_end"));
							return;
						}
						continue;
					}

					if (msg.type === "event" && msg.event === "turn_end" && waitForEvent === "turn_end") {
						if (!response) {
							settle(new Error("Received event before response"));
							return;
						}
						settle(undefined, { response, event: (msg.data as { message?: ExtractedMessage; turnIndex?: number }) || {} });
						return;
					}
				} catch {
					// Ignore parse errors, keep waiting for a complete valid message.
				}
			}
		});

		socket.on("error", (error) => settle(error));
		socket.on("end", () => settle(new Error("Socket ended before RPC completed")));
		socket.on("close", () => settle(new Error("Socket closed before RPC completed")));
	});
}
