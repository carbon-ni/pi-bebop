import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import {
	closeRpcServer,
	createRpcServer,
	writeEvent,
	writeMemberIdleWaitEvent,
	writeMemberUpdateEvent,
	writeResponse,
} from "./rpc-server.ts";
import type { RpcInboundCommand } from "../domain/index.ts";
import type { RpcSocket } from "./rpc-server.ts";

async function withSocketServer(run: (socketPath: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "intray-rpc-server-"));
	try {
		await run(path.join(dir, "server.sock"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function sendLine(socketPath: string, line: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("connect", () => socket.write(`${line}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const response = buffer.slice(0, newlineIndex);
			socket.end();
			resolve(response);
		});
		socket.on("error", reject);
	});
}

test("createRpcServer dispatches parsed commands to handler", async () => {
	await withSocketServer(async (socketPath) => {
		let received: RpcInboundCommand | undefined;
		const server = await createRpcServer(socketPath, (command, socket) => {
			received = command;
			writeResponse(socket, {
				type: "response",
				command: command.type,
				success: true,
				id: command.id,
				data: { message: null },
			});
		});
		try {
			const response = await sendLine(
				socketPath,
				JSON.stringify({ jsonrpc: "2.0", id: "get-1", method: "session.get_message" }),
			);

			assert.deepEqual(received, { type: "get_message", id: "get-1" });
			assert.deepEqual(JSON.parse(response), { jsonrpc: "2.0", id: "get-1", result: { message: null } });
		} finally {
			await closeRpcServer(server);
		}
	});
});

test("rejects unknown methods, extra params, non-RPC envelopes, and malformed envelopes before dispatch", async () => {
	await withSocketServer(async (socketPath) => {
		let dispatched = 0;
		const server = await createRpcServer(socketPath, () => {
			dispatched += 1;
		});
		try {
			const invalidRequests: Array<[string, number]> = [
				["{ nope", -32700],
				[JSON.stringify({ jsonrpc: "1.0", id: "version", method: "session.status" }), -32600],
				[JSON.stringify({ jsonrpc: "2.0", method: "session.status" }), -32600],
				[JSON.stringify({ jsonrpc: "2.0", id: "extra", method: "session.status", extra: true }), -32600],
				[JSON.stringify({ jsonrpc: "2.0", id: "unknown", method: "no.such" }), -32601],
				[JSON.stringify({ jsonrpc: "2.0", id: "null", method: "message.send", params: null }), -32602],
				[
					JSON.stringify({ jsonrpc: "2.0", id: "type", method: "message.send", params: { content: 1 } }),
					-32602,
				],
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: "enum",
						method: "message.send",
						params: { content: "x", delivery: "later" },
					}),
					-32602,
				],
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: "extra-params",
						method: "message.send",
						params: { content: "x", extra: true },
					}),
					-32602,
				],
				[JSON.stringify({ jsonrpc: "2.0", id: "missing", method: "message.send", params: {} }), -32602],
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: "oversized",
						method: "message.send",
						params: { content: "x".repeat(1_000_001) },
					}),
					-32602,
				],
				[JSON.stringify({ type: "send", message: "x" }), -32600],
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: "hint-whitespace",
						method: "presence.hint",
						params: {
							member: { identity: " /crew/dev.sock ", name: "dev", role: "developer" },
							state: "online",
							instanceId: "peer",
						},
					}),
					-32602,
				],
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: "hint-nul",
						method: "presence.hint",
						params: {
							member: { identity: "/crew/dev.sock", name: "dev\u0000", role: "developer" },
							state: "online",
							instanceId: "peer",
						},
					}),
					-32602,
				],
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: "hint-extra",
						method: "presence.hint",
						params: {
							member: { identity: "/crew/dev.sock", name: "dev", role: "developer" },
							state: "online",
							instanceId: "peer",
							extra: true,
						},
					}),
					-32602,
				],
			];
			for (const [line, code] of invalidRequests) {
				const response = JSON.parse(await sendLine(socketPath, line));
				assert.equal(response.jsonrpc, "2.0");
				assert.equal(response.error.code, code);
			}
			assert.equal(dispatched, 0);
		} finally {
			await closeRpcServer(server);
		}
	});
});

test("createRpcServer returns parse errors without dispatching invalid commands", async () => {
	await withSocketServer(async (socketPath) => {
		let dispatched = false;
		const server = await createRpcServer(socketPath, () => {
			dispatched = true;
		});
		try {
			const response = await sendLine(socketPath, "{ nope");

			assert.equal(dispatched, false);
			assert.equal(JSON.parse(response).jsonrpc, "2.0");
			assert.equal(JSON.parse(response).error.code, -32700);
			assert.equal(JSON.parse(response).id, null);
		} finally {
			await closeRpcServer(server);
		}
	});
});

test("writeResponse serializes strict presence hint acknowledgements", () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	writeResponse(socket, {
		type: "response",
		command: "presence_hint",
		success: true,
		data: { accepted: true },
		id: "hint",
	});
	assert.deepEqual(JSON.parse(writes[0]!), { jsonrpc: "2.0", id: "hint", result: { accepted: true } });
});

test("writeResponse preserves durable application error codes for CLI mapping", () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	writeResponse(socket, {
		type: "response",
		command: "crew_broadcast",
		success: false,
		error: "untrusted-project",
		id: "broadcast-error",
	});
	assert.deepEqual(JSON.parse(writes[0]!).error.data, { code: "untrusted-project" });
});

test("writeResponse ignores closed socket write errors", () => {
	const socket = {
		write() {
			throw new Error("closed");
		},
		once() {
			return socket;
		},
	} as unknown as RpcSocket;

	assert.doesNotThrow(() =>
		writeResponse(socket, {
			type: "response",
			command: "send",
			success: true,
			id: "send-1",
			data: { deliveryId: "delivery-test", disposition: "steered" },
		}),
	);
});

test("rejects a response without a correlated id instead of fabricating one", () => {
	const writes: string[] = [];
	const socket = {
		write(value: string) {
			writes.push(value);
		},
		once() {
			return socket;
		},
	} as unknown as RpcSocket;
	writeResponse(socket, {
		type: "response",
		command: "send",
		success: true,
		id: undefined as never,
		data: { deliveryId: "delivery-test", disposition: "steered" },
	});
	assert.equal(JSON.parse(writes[0]!).error.code, -32600);
});

test("rejects invalid method results and unknown commands without writing invalid success payloads", () => {
	const writes: string[] = [];
	const socket = {
		write(value: string) {
			writes.push(value);
		},
		once() {
			return socket;
		},
	} as unknown as RpcSocket;
	writeResponse(socket, {
		type: "response",
		command: "status",
		success: true,
		id: "status-1",
		data: { status: "not-a-status" } as never,
	});
	assert.equal(writes.length, 1);
	assert.equal(JSON.parse(writes[0]!).error.code, -32603);
	writeResponse(socket, { type: "response", command: "unknown", success: true, id: "unknown-1", data: {} });
	assert.equal(JSON.parse(writes[1]!).error.data.code, "unknown-command");
});

test("rejects invalid turn-end events before writing", () => {
	const writes: string[] = [];
	const socket = {
		write(value: string) {
			writes.push(value);
		},
		once() {
			return socket;
		},
	} as unknown as RpcSocket;
	assert.throws(() =>
		writeEvent(socket, {
			type: "event",
			event: "turn_end",
			subscriptionId: "sub-1",
			data: { message: { role: "assistant", content: "missing timestamp" } as never },
		}),
	);
	assert.equal(writes.length, 0);
});

test("writeEvent ignores closed socket write errors", () => {
	const socket = {
		write() {
			throw new Error("closed");
		},
		once() {
			return socket;
		},
	} as unknown as RpcSocket;

	assert.doesNotThrow(() =>
		writeEvent(socket, {
			type: "event",
			event: "turn_end",
			data: { message: { role: "assistant", content: "done", timestamp: 1 } },
			subscriptionId: "sub-1",
		}),
	);
});

test("writeResponse maps every command method and non-durable failures", () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	for (const [index, command] of [
		"status",
		"send",
		"interrupt",
		"member_status",
		"member_status_target",
		"member_request",
		"member_response",
		"member_interrupt",
		"member_follow_up",
		"member_redirect",
		"member_inbox_send",
		"crew_broadcast",
		"member_idle_wait",
		"get_message",
		"clear",
		"abort",
		"subscribe",
		"presence_hint",
	].entries())
		writeResponse(socket, {
			type: "response",
			command,
			success: false,
			error: "remote-rejected",
			id: `r-${index}`,
		} as never);
	assert.equal(writes.length, 18);
});

test("writeResponse maps non-durable failures and member response commands", () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	writeResponse(socket, {
		type: "response",
		command: "member_response",
		success: false,
		error: "remote-rejected",
		id: "r-1",
	});
	assert.equal(JSON.parse(writes[0]!).error.message, "remote-rejected");
	writeResponse(socket, {
		type: "response",
		command: "member_response",
		success: true,
		data: { requestId: "req-1", message: "done" },
		id: "r-2",
	});
	assert.equal(JSON.parse(writes[1]!).id, "r-2");
});

test("writeResponse serializes an interrupt acknowledgement", () => {
	const writes: string[] = [];
	const socket = {
		write: (value: string) => {
			writes.push(value);
		},
		once: () => socket,
	} as never;
	writeResponse(socket as never, {
		type: "response",
		command: "interrupt",
		success: true,
		data: { interruptId: "int-1", disposition: "interrupt-requested" },
		id: "int-1",
	});
	assert.deepEqual(JSON.parse(writes[0]!), {
		jsonrpc: "2.0",
		id: "int-1",
		result: { interruptId: "int-1", disposition: "interrupt-requested" },
	});
});

test("writeMemberUpdateEvent and idle events serialize valid notifications", () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	writeMemberUpdateEvent(socket, {
		kind: "response",
		requestId: "req-1",
		member: { name: "Bob", role: "dev" },
		message: "done",
	});
	writeMemberIdleWaitEvent(socket, {
		subscriptionId: "sub-1",
		result: {
			member: { name: "Bob", role: "dev" },
			outcome: "idle",
			disposition: "already-idle",
			observedAt: "2026-08-24T00:00:00.000Z",
		},
	});
	assert.equal(writes.length, 2);
	assert.equal(JSON.parse(writes[0]!).params.requestId, "req-1");
	assert.equal(JSON.parse(writes[1]!).params.subscriptionId, "sub-1");
});

test("writeResponse serializes a member.status result under the member.status method", () => {
	const writes: string[] = [];
	const socket = {
		write: (value: string) => {
			writes.push(value);
		},
		once: () => socket,
	} as never;
	const status = {
		member: { name: "Bob", role: "dev" },
		presence: "online",
		activity: "idle",
		hasPendingMessages: false,
		observedAt: "2026-08-23T12:03:00.000Z",
	};
	writeResponse(socket as never, {
		type: "response",
		command: "member_status",
		success: true,
		data: { status },
		id: "ms-1",
	});
	assert.deepEqual(JSON.parse(writes[0]!), {
		jsonrpc: "2.0",
		id: "ms-1",
		result: { status },
	});
});
