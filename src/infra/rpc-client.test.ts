import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { sendRpcCommand } from "./rpc-client.ts";

async function withSocketServer(
	handleConnection: (socket: net.Socket) => void,
	run: (socketPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "intray-rpc-client-"));
	const socketPath = path.join(dir, "server.sock");
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handleConnection(socket);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	try {
		await run(socketPath);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
}

function writeMessage(socket: net.Socket, message: unknown): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

function handleLines(socket: net.Socket, handle: (message: Record<string, unknown>) => void): void {
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
			if (line) handle(JSON.parse(line) as Record<string, unknown>);
		}
	});
}

test("sendRpcCommand resolves once after command response and turn_end event", async () => {
	await withSocketServer(
		(socket) => {
			handleLines(socket, (message) => {
				if (message.type === "send") {
					writeMessage(socket, { type: "response", command: "send", success: true });
				}
				if (message.type === "subscribe") {
					writeMessage(socket, { type: "response", command: "subscribe", success: true });
					setTimeout(() => writeMessage(socket, {
						type: "event",
						event: "turn_end",
						data: { message: { content: "done" }, turnIndex: 3 },
					}), 5);
				}
			});
		},
		async (socketPath) => {
			const result = await sendRpcCommand(socketPath, { type: "send", message: "hello" }, {
				waitForEvent: "turn_end",
				timeout: 1000,
			});
			assert.equal(result.response.success, true);
			assert.deepEqual(result.event, { message: { content: "done" }, turnIndex: 3 });
		},
	);
});

test("sendRpcCommand rejects a failed command response without waiting for an event", async () => {
	await withSocketServer(
		(socket) => handleLines(socket, (message) => {
			if (message.type === "send") {
				writeMessage(socket, { type: "response", command: "send", success: false, error: "busy" });
			}
		}),
		async (socketPath) => {
			await assert.rejects(
			() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { waitForEvent: "turn_end", timeout: 1000 }),
			/error: busy|busy/,
		);
		},
	);
});

test("sendRpcCommand rejects promptly when aborted", async () => {
	await withSocketServer(
		() => undefined,
		async (socketPath) => {
			const controller = new AbortController();
			const pending = sendRpcCommand(socketPath, { type: "send", message: "hello" }, {
				waitForEvent: "turn_end",
				timeout: 1000,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 10);
			await assert.rejects(pending, /abort/i);
		},
	);
});

test("sendRpcCommand rejects when the socket ends before completion", async () => {
	await withSocketServer(
		(socket) => socket.end(),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { timeout: 1000 }),
				/socket (ended|closed)|closed/i,
			);
		},
	);
});

test("sendRpcCommand rejects when the socket closes before completion", async () => {
	await withSocketServer(
		(socket) => socket.on("data", () => socket.destroy()),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { timeout: 1000 }),
				/socket (ended|closed)|closed/i,
			);
		},
	);
});

test("sendRpcCommand rejects once on timeout", async () => {
	await withSocketServer(
		() => undefined,
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { timeout: 20 }),
				/timeout/i,
			);
		},
	);
});

test("defers malformed RPC output classification to TASK-0024 and times out for now", async () => {
	await withSocketServer(
		(socket) => socket.write("not-json\\n"),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { timeout: 20 }),
				/timeout/i,
			);
		},
	);
});

test("sendRpcCommand rejects a failed subscription response", async () => {
	await withSocketServer(
		(socket) => handleLines(socket, (message) => {
			if (message.type === "send") {
				writeMessage(socket, { type: "response", command: "send", success: true });
			}
			if (message.type === "subscribe") {
				writeMessage(socket, { type: "response", command: "subscribe", success: false, error: "not supported" });
			}
		}),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { waitForEvent: "turn_end", timeout: 1000 }),
				/not supported/i,
			);
		},
	);
});
