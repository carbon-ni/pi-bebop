import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { sendRpcCommand, sendMemberIdleWait, sendMemberRequest, RpcProtocolError } from "./rpc-client.ts";

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

test("sendRpcCommand covers explicit ids and abort reason normalization", async () => {
	for (const reason of [new Error("reason"), "string reason", undefined]) {
		const controller = new AbortController();
		controller.abort(reason);
		await assert.rejects(
			() =>
				sendRpcCommand(
					"/tmp/not-used.sock",
					{ type: "send", id: "explicit", message: "x" },
					{ signal: controller.signal },
				),
			(error: unknown) => {
				assert.match(String(error), /reason|aborted/i);
				return true;
			},
		);
	}
	await withSocketServer(
		(socket) =>
			lines(socket, (request) =>
				send(socket, { jsonrpc: "2.0", id: request.id, result: { deliveryId: "d-1", disposition: "direct" } }),
			),
		async (socketPath) => {
			const result = await sendRpcCommand(socketPath, { type: "send", id: "explicit", message: "x" });
			assert.equal(result.response.id, "explicit");
		},
	);
});

test("keeps an accepted member request socket open for exactly one correlated update", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.request") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					result: {
						accepted: true,
						requestId: request.params.requestId,
						member: { name: "qa", role: "reviewer" },
					},
				});
				setTimeout(
					() =>
						send(socket, {
							jsonrpc: "2.0",
							method: "member.update",
							params: {
								kind: "response",
								requestId: request.params.requestId,
								member: { name: "qa", role: "reviewer" },
								message: "reviewed",
							},
						}),
					1,
				);
			}),
		async (socketPath) => {
			const updates: unknown[] = [];
			const result = await sendMemberRequest(
				socketPath,
				{
					type: "member_request",
					requestId: "request-1",
					payload: { content: "review", origin: { kind: "crew", name: "dev", role: "developer" } },
					timeoutSeconds: 300,
				},
				{ timeout: 1000, onUpdate: (update) => updates.push(update) },
			);
			assert.equal(result.response.success, true);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(updates.length, 1);
			result.close();
		},
	);
});

test("classifies malformed and cancelled member request transport before acceptance", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "member.request") socket.write("not-json\n");
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendMemberRequest(
						socketPath,
						{ type: "member_request", requestId: "bad-1", payload: { content: "x" }, timeoutSeconds: 1 },
						{ timeout: 1000, onUpdate: () => undefined },
					),
				/malformed/i,
			);
		},
	);
	const controller = new AbortController();
	await withSocketServer(
		() => undefined,
		async (socketPath) => {
			const pending = sendMemberRequest(
				socketPath,
				{ type: "member_request", requestId: "cancel-1", payload: { content: "x" }, timeoutSeconds: 1 },
				{ timeout: 1000, signal: controller.signal, onUpdate: () => undefined },
			);
			controller.abort();
			await assert.rejects(() => pending, /aborted/i);
		},
	);
});

test("classifies a dispatched member request with a lost acceptance as outcome-unknown", async () => {
	await withSocketServer(
		(socket) => lines(socket, () => socket.destroy()),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendMemberRequest(
						socketPath,
						{ type: "member_request", requestId: "lost-1", payload: { content: "x" }, timeoutSeconds: 1 },
						{ timeout: 1000, onUpdate: () => undefined },
					),
				(error: unknown) => error instanceof RpcProtocolError && error.code === "outcome-unknown",
			);
		},
	);
});

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
				/ended|closed|outcome-unknown/i,
			);
		},
	);
});

test("dispatch barrier distinguishes pre-dispatch abort from accepted-before-ack loss", async () => {
	let preDispatchReceipts = 0;
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send") preDispatchReceipts += 1;
			}),
		async (socketPath) => {
			const controller = new AbortController();
			const pending = sendRpcCommand(
				socketPath,
				{ type: "send", message: "cancel before write" },
				{ timeout: 1000, signal: controller.signal },
			);
			controller.abort();
			await assert.rejects(pending, (error: unknown) => {
				assert.equal(error instanceof RpcProtocolError, false);
				assert.match(String(error), /abort/i);
				assert.doesNotMatch(String(error), /outcome-unknown/i);
				return true;
			});
		},
	);
	assert.equal(preDispatchReceipts, 0, "pre-dispatch abort must not reach the target");

	let targetAccepted = false;
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "message.send") return;
				// Simulate the target accepting the delivery, followed by loss of
				// the outer source acknowledgement before the caller receives it.
				targetAccepted = true;
				socket.end();
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "accepted then ack lost" },
						{ timeout: 1000, classifyLostAck: true },
					),
				(error: unknown) => {
					assert.equal(targetAccepted, true);
					assert.equal(error instanceof RpcProtocolError, true);
					assert.equal((error as RpcProtocolError).code, "outcome-unknown");
					return true;
				},
			);
		},
	);

	let durableAccepted = false;
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "crew.broadcast") return;
				durableAccepted = true;
				socket.end();
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "crew_broadcast", message: "durable accepted then ack lost" },
						{ timeout: 1000, classifyLostAck: true },
					),
				(error: unknown) => {
					assert.equal(durableAccepted, true);
					assert.equal(error instanceof RpcProtocolError, true);
					assert.equal((error as RpcProtocolError).code, "outcome-unknown");
					return true;
				},
			);
		},
	);

	let abortAfterDispatch: (() => void) | undefined;
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send") abortAfterDispatch?.();
			}),
		async (socketPath) => {
			const controller = new AbortController();
			abortAfterDispatch = () => controller.abort();
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "accepted before caller abort" },
						{ timeout: 1000, signal: controller.signal, classifyLostAck: true },
					),
				(error: unknown) => {
					assert.equal(error instanceof RpcProtocolError, true);
					assert.equal((error as RpcProtocolError).code, "outcome-unknown");
					return true;
				},
			);
		},
	);

	let deadlineAccepted = false;
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method === "message.send") deadlineAccepted = true;
				// Deliberately withhold the acknowledgement until the deadline.
			}),
		async (socketPath) => {
			await assert.rejects(
				() =>
					sendRpcCommand(
						socketPath,
						{ type: "send", message: "accepted then deadline" },
						{ timeout: 20, classifyLostAck: true },
					),
				(error: unknown) => {
					assert.equal(deadlineAccepted, true);
					assert.equal(error instanceof RpcProtocolError, true);
					assert.equal((error as RpcProtocolError).code, "outcome-unknown");
					return true;
				},
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

test("sendMemberIdleWait resolves the terminal event for a busy target that settles", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.idle_wait") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					result: { subscriptionId: String(request.id), event: "member_idle" },
				});
				setTimeout(
					() =>
						send(socket, {
							jsonrpc: "2.0",
							method: "member.idle_wait",
							params: {
								subscriptionId: String(request.id),
								result: {
									member: { name: "Kelly", role: "qa" },
									outcome: "idle",
									disposition: "became-idle",
									observedAt: "2026-08-23T12:03:00.000Z",
								},
							},
						}),
					1,
				);
			}),
		async (socketPath) => {
			const outcome = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Kelly" },
				{ timeoutSeconds: 10 },
			);
			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.result.outcome, "idle");
				assert.equal(outcome.result.disposition, "became-idle");
			}
		},
	);
});

test("sendMemberIdleWait returns offline when the socket closes before any terminal event", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.idle_wait") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					result: { subscriptionId: String(request.id), event: "member_idle" },
				});
				socket.destroy();
			}),
		async (socketPath) => {
			const outcome = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Kelly" },
				{ timeoutSeconds: 10 },
			);
			assert.deepEqual(outcome, { ok: false, code: "offline" });
		},
	);
});

test("sendMemberIdleWait returns timeout when the deadline expires before a terminal event", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.idle_wait") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					result: { subscriptionId: String(request.id), event: "member_idle" },
				});
				// Never send the terminal event.
			}),
		async (socketPath) => {
			const outcome = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Kelly" },
				{ timeoutSeconds: 1 },
			);
			assert.deepEqual(outcome, { ok: false, code: "timeout" });
		},
	);
});

test("sendMemberIdleWait classifies endpoint errno and capacity outcomes", async () => {
	const outcome = await sendMemberIdleWait(
		`/tmp/missing-idle-ENOENT.sock`,
		{ type: "member_idle_wait", member: "Bob" },
		{ timeoutSeconds: 1 },
	);
	assert.deepEqual(outcome, { ok: false, code: "transport-error", transportCode: "ENOENT" });
	await withSocketServer(
		(socket) =>
			lines(socket, (request) =>
				send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "capacity exceeded" } }),
			),
		async (socketPath) => {
			const outcome = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Bob" },
				{ timeoutSeconds: 1 },
			);
			assert.deepEqual(outcome, { ok: false, code: "capacity-exceeded" });
		},
	);
});

test("sendMemberIdleWait returns aborted when the caller signal fires", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.idle_wait") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					result: { subscriptionId: String(request.id), event: "member_idle" },
				});
			}),
		async (socketPath) => {
			const controller = new AbortController();
			const pending = sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Kelly" },
				{ timeoutSeconds: 60, signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 10);
			const outcome = await pending;
			assert.deepEqual(outcome, { ok: false, code: "aborted" });
		},
	);
});

test("sendMemberIdleWait maps remote rejection and malformed terminal results", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.idle_wait") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32603, message: "capacity-exceeded" },
				});
			}),
		async (socketPath) => {
			const outcome = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Kelly" },
				{ timeoutSeconds: 10 },
			);
			assert.deepEqual(outcome, { ok: false, code: "capacity-exceeded" });
		},
	);
	await withSocketServer(
		(socket) =>
			lines(socket, (request) => {
				if (request.method !== "member.idle_wait") return;
				send(socket, {
					jsonrpc: "2.0",
					id: request.id,
					result: { subscriptionId: String(request.id), event: "member_idle" },
				});
				setTimeout(
					() =>
						send(socket, {
							jsonrpc: "2.0",
							method: "member.idle_wait",
							params: {
								subscriptionId: String(request.id),
								result: {
									member: { name: "Kelly", role: "qa" },
									outcome: "bogus",
									observedAt: "2026-08-23T12:03:00.000Z",
								},
							},
						}),
					1,
				);
			}),
		async (socketPath) => {
			const outcome = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Kelly" },
				{ timeoutSeconds: 10 },
			);
			assert.deepEqual(outcome, { ok: false, code: "malformed-response" });
		},
	);
});

test("sendMemberIdleWait rejects wrong acknowledgement ids and out-of-order notifications", async () => {
	await withSocketServer(
		(socket) =>
			lines(socket, (request) =>
				send(socket, {
					jsonrpc: "2.0",
					id: "wrong",
					result: { subscriptionId: "wrong", event: "member_idle" },
				}),
			),
		async (socketPath) => {
			const result = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Bob" },
				{ timeoutSeconds: 1 },
			);
			assert.deepEqual(result, { ok: false, code: "malformed-response" });
		},
	);
	await withSocketServer(
		(socket) =>
			lines(socket, (request) =>
				send(socket, {
					jsonrpc: "2.0",
					method: "member.idle_wait",
					params: { subscriptionId: String(request.id), result: {} },
				}),
			),
		async (socketPath) => {
			const result = await sendMemberIdleWait(
				socketPath,
				{ type: "member_idle_wait", member: "Bob" },
				{ timeoutSeconds: 1 },
			);
			assert.deepEqual(result, { ok: false, code: "malformed-response" });
		},
	);
});
