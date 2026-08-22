import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { closeRpcServer, createRpcServer, writeEvent, writeResponse } from "./rpc-server.ts";
import type { RpcCommand } from "../domain/index.ts";
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
		let received: RpcCommand | undefined;
		const server = await createRpcServer(socketPath, (command, socket) => {
			received = command;
			writeResponse(socket, { type: "response", command: command.type, success: true, id: command.id, data: { message: null } });
		});
		try {
			const response = await sendLine(socketPath, JSON.stringify({ jsonrpc: "2.0", id: "get-1", method: "session.get_message" }));

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
		const server = await createRpcServer(socketPath, () => { dispatched += 1; });
		try {
			for (const [line, code] of [
				[JSON.stringify({ jsonrpc: "2.0", id: "unknown", method: "no.such" }), -32601],
				[JSON.stringify({ jsonrpc: "2.0", id: "params", method: "message.send", params: { message: "x", extra: true } }), -32602],
				[JSON.stringify({ type: "send", message: "x" }), -32600],
			]) {
				const response = JSON.parse(await sendLine(socketPath, line));
				assert.equal(response.jsonrpc, "2.0"); assert.equal(response.error.code, code); assert.equal(response.id === null || response.id === "unknown" || response.id === "params", true);
			}
			assert.equal(dispatched, 0);
		} finally { await closeRpcServer(server); }
	});
});

test("createRpcServer returns parse errors without dispatching invalid commands", async () => {
	await withSocketServer(async (socketPath) => {
		let dispatched = false;
		const server = await createRpcServer(
			socketPath,
			() => {
				dispatched = true;
			},
		);
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

test("writeResponse ignores closed socket write errors", () => {
	const socket = {
		write() {
			throw new Error("closed");
		},
		once() {
			return socket;
		},
	} as unknown as RpcSocket;

	assert.doesNotThrow(() => writeResponse(socket, { type: "response", command: "send", success: true, id: "send-1", data: { delivered: true, mode: "steer" } }));
});

test("rejects a response without a correlated id instead of fabricating one", () => {
	const writes: string[] = [];
	const socket = { write(value: string) { writes.push(value); }, once() { return socket; } } as unknown as RpcSocket;
	writeResponse(socket, { type: "response", command: "send", success: true, id: undefined as never, data: { delivered: true, mode: "steer" } });
	assert.equal(JSON.parse(writes[0]!).error.code, -32600);
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

	assert.doesNotThrow(() => writeEvent(socket, { type: "event", event: "turn_end", data: { message: { role: "assistant", content: "done", timestamp: 1 } }, subscriptionId: "sub-1" }));
});
