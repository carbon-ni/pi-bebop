import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { sendRpcCommand, RpcProtocolError } from "./rpc-client.ts";

async function withSocketServer(
	handle: (socket: net.Socket) => void,
	run: (socketPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "jrpc-client-"));
	const socketPath = path.join(dir, "server.sock");
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handle(socket);
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		await run(socketPath);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
}
function send(socket: net.Socket, value: unknown): void {
	socket.write(`${JSON.stringify(value)}\n`);
}
function lines(socket: net.Socket, handler: (value: Record<string, unknown>) => void): void {
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		let i = buffer.indexOf("\n");
		while (i !== -1) {
			const line = buffer.slice(0, i).trim();
			buffer = buffer.slice(i + 1);
			i = buffer.indexOf("\n");
			if (line) handler(JSON.parse(line));
		}
	});
}

test("correlates send and subscription responses then accepts the matching turn notification", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send")
					send(socket, {
						jsonrpc: "2.0",
						id: request.id,
						result: { deliveryId: "delivery-test", disposition: "steered" },
					});
				if (request.method === "event.subscribe") {
					send(socket, {
						jsonrpc: "2.0",
						id: request.id,
						result: { subscriptionId: String(request.id), event: "turn_end" },
					});
					setTimeout(
						() =>
							send(socket, {
								jsonrpc: "2.0",
								method: "session.turn_end",
								params: {
									subscriptionId: String(request.id),
									message: { role: "assistant", content: "done", timestamp: 1 },
									turnIndex: 3,
								},
							}),
						1,
					);
				}
			}),
		async (socketPath) => {
			const result = await sendRpcCommand(
				socketPath,
				{ type: "send", message: "hello" },
				{ waitForEvent: "turn_end", timeout: 100 },
			);
			assert.equal(result.event?.message?.content, "done");
		},
	);
});

test("requires primary response and matching subscription acknowledgement in either response order", async () => {
	for (const reverse of [false, true]) {
		await withSocketServer(
			(socket) => {
				const requests: Record<string, unknown>[] = [];
				lines(socket, (request) => {
					requests.push(request);
					if (requests.length !== 2) return;
					const primary = requests.find((item) => item.method === "message.send")!;
					const subscribe = requests.find((item) => item.method === "event.subscribe")!;
					const frames = [
						{
							jsonrpc: "2.0",
							id: primary.id,
							result: { deliveryId: "delivery-test", disposition: "steered" },
						},
						{
							jsonrpc: "2.0",
							id: subscribe.id,
							result: { subscriptionId: String(subscribe.id), event: "turn_end" },
						},
						{
							jsonrpc: "2.0",
							method: "session.turn_end",
							params: {
								subscriptionId: String(subscribe.id),
								message: { role: "assistant", content: "done", timestamp: 1 },
								turnIndex: 1,
							},
						},
					];
					for (const frame of reverse ? [frames[1], frames[0], frames[2]] : frames) send(socket, frame);
				});
			},
			async (socketPath) => {
				const result = await sendRpcCommand(
					socketPath,
					{ type: "send", message: "x" },
					{ waitForEvent: "turn_end", timeout: 1000 },
				);
				assert.equal(result.event?.message?.content, "done");
			},
		);
	}
});

test("rejects a turn notification before either required response or acknowledgement", async () => {
	for (const order of ["before-primary", "before-ack"] as const) {
		await withSocketServer(
			(socket) => {
				const requests: Record<string, unknown>[] = [];
				lines(socket, (request) => {
					requests.push(request);
					if (requests.length !== 2) return;
					const primary = requests.find((item) => item.method === "message.send")!;
					const subscribe = requests.find((item) => item.method === "event.subscribe")!;
					const primaryFrame = {
						jsonrpc: "2.0",
						id: primary.id,
						result: { deliveryId: "delivery-test", disposition: "steered" },
					};
					const ackFrame = {
						jsonrpc: "2.0",
						id: subscribe.id,
						result: { subscriptionId: String(subscribe.id), event: "turn_end" },
					};
					const event = {
						jsonrpc: "2.0",
						method: "session.turn_end",
						params: { subscriptionId: String(subscribe.id), message: null },
					};
					for (const frame of order === "before-primary"
						? [ackFrame, event, primaryFrame]
						: [primaryFrame, event, ackFrame])
						send(socket, frame);
				});
			},
			async (socketPath) => {
				await assert.rejects(
					() =>
						sendRpcCommand(
							socketPath,
							{ type: "send", message: "x" },
							{ waitForEvent: "turn_end", timeout: 1000 },
						),
					/out-of-order-(ack|response)/i,
				);
			},
		);
	}
});

test("rejects a subscription acknowledgement with the wrong subscription id", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send")
					send(socket, {
						jsonrpc: "2.0",
						id: request.id,
						result: { deliveryId: "delivery-test", disposition: "steered" },
					});
				if (request.method === "event.subscribe")
					send(socket, {
						jsonrpc: "2.0",
						id: request.id,
						result: { subscriptionId: "other", event: "turn_end" },
					});
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "x" },
						{ waitForEvent: "turn_end", timeout: 1000 },
					),
				/mismatched-subscription-id/i,
			);
		},
	);
});

test("rejects remote JSON-RPC errors without waiting for notifications", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send")
					send(socket, { jsonrpc: "2.0", id: request.id, error: { code: 5000, message: "busy" } });
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "hello" },
						{ waitForEvent: "turn_end", timeout: 1000 },
					),
				/busy/,
			);
		},
	);
});

test("rejects promptly when aborted, socket ends, or timeout occurs", async () => {
	await withSocketServer(
		() => undefined,
		async (socketPath) => {
			const controller = new AbortController();
			const pending = sendRpcCommand(
				socketPath,
				{ type: "send", message: "hello" },
				{ timeout: 1000, signal: controller.signal },
			);
			controller.abort();
			await assert.rejects(pending, /abort/i);
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { timeout: 20 }),
				/timeout/i,
			);
		},
	);
	await withSocketServer(
		(socket) => socket.end(),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "hello" }, { timeout: 1000 }),
				/ended|closed/i,
			);
		},
	);
});

test("fails immediately on malformed, mismatched, duplicate, invalid, or wrong-subscription peers", async () => {
	await withSocketServer(
		(socket) => socket.write("not-json\n"),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "x" }, { timeout: 1000 }),
				/malformed JSON-RPC response/i,
			);
		},
	);
	await withSocketServer(
		(socket) =>
			lines(socket, (request) =>
				send(socket, {
					jsonrpc: "2.0",
					id: "wrong",
					result: { deliveryId: "delivery-test", disposition: "steered" },
				}),
			),
		async (socketPath) => {
			await assert.rejects(
				() => sendRpcCommand(socketPath, { type: "send", message: "x" }, { timeout: 1000 }),
				/mismatched-id/i,
			);
		},
	);
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				const response = {
					jsonrpc: "2.0",
					id: request.id,
					result: { deliveryId: "delivery-test", disposition: "steered" },
				};
				send(socket, response);
				send(socket, response);
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "x" },
						{ waitForEvent: "turn_end", timeout: 1000 },
					),
				/duplicate-id/i,
			);
		},
	);
	await withSocketServer(
		(socket) =>
			lines(socket, (request) =>
				send(socket, { jsonrpc: "2.0", method: "session.turn_end", params: { subscriptionId: "wrong" } }),
			),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "x" },
						{ waitForEvent: "turn_end", timeout: 1000 },
					),
				/unexpected-notification/i,
			);
		},
	);
	for (const malformed of [
		{ jsonrpc: "1.0", id: "x", result: { deliveryId: "delivery-test", disposition: "steered" } },
		{
			jsonrpc: "2.0",
			id: "x",
			result: { deliveryId: "delivery-test", disposition: "steered" },
			error: { code: 1, message: "both" },
		},
		{ jsonrpc: "2.0", id: "x", result: { deliveryId: "delivery-test", disposition: "steered" }, extra: true },
	])
		await withSocketServer(
			(socket) => lines(socket, (request) => send(socket, malformed)),
			async (socketPath) => {
				await assert.rejects(
					() => sendRpcCommand(socketPath, { type: "send", message: "x" }, { timeout: 1000 }),
					/malformed-response|mismatched-id/i,
				);
			},
		);
});

test("rejects failed subscription responses", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send")
					send(socket, {
						jsonrpc: "2.0",
						id: request.id,
						result: { deliveryId: "delivery-test", disposition: "steered" },
					});
				if (request.method === "event.subscribe")
					send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "not supported" } });
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "hello" },
						{ waitForEvent: "turn_end", timeout: 1000 },
					),
				/not supported/,
			);
		},
	);
});

test("accepts strict presence hint acknowledgements true and false", async () => {
	for (const accepted of [true, false])
		await withSocketServer(
			(socket) =>
				lines(socket, (request) => {
					if (request.method === "presence.hint")
						send(socket, { jsonrpc: "2.0", id: request.id, result: { accepted } });
				}),
			async (socketPath) => {
				const result = await sendRpcCommand(socketPath, {
					type: "presence_hint",
					member: { identity: "/crew/dev.sock", name: "dev", role: "developer" },
					state: "online",
					instanceId: "peer",
				});
				assert.deepEqual(result.response.data, { accepted });
			},
		);
});

test("rejects malformed presence hint acknowledgements", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "presence.hint") send(socket, { jsonrpc: "2.0", id: request.id, result: {} });
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(socketPath, {
						type: "presence_hint",
						member: { identity: "/crew/dev.sock", name: "dev", role: "developer" },
						state: "online",
						instanceId: "peer",
					}),
				/invalid|response/i,
			);
		},
	);
});
