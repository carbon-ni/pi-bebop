import assert from "node:assert/strict";
import * as net from "node:net";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMemberLastMessageTransport } from "./member-last-message-transport.ts";

async function socketServer(
	handler: (socket: net.Socket, request: { id: string | number }) => void,
): Promise<{ socketPath: string; close: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-last-message-transport-"));
	const socketPath = path.join(root, "target.sock");
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		socket.once("data", (chunk) => handler(socket, JSON.parse(String(chunk)) as { id: string | number }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return {
		socketPath,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

async function request(socketPath: string, timeoutMs = 5000, signal?: AbortSignal) {
	return createMemberLastMessageTransport(timeoutMs).requestLastMessage(socketPath, signal);
}

test("last-message transport performs one direct read and preserves the structured snapshot", async () => {
	let requests = 0;
	const peer = await socketServer((socket, request) => {
		requests += 1;
		socket.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: { message: { role: "assistant", content: "latest", timestamp: 10 } },
			})}\n`,
		);
	});
	try {
		assert.deepEqual(await request(peer.socketPath), {
			ok: true,
			message: { role: "assistant", content: "latest", timestamp: 10 },
		});
		assert.equal(requests, 1);
	} finally {
		await peer.close();
	}
});

test("last-message transport maps a malformed Unix peer response to malformed-response", async () => {
	const peer = await socketServer((socket) => socket.write("not-json\n"));
	try {
		assert.deepEqual(await request(peer.socketPath), { ok: false, code: "malformed-response" });
	} finally {
		await peer.close();
	}
});

test("last-message transport maps invalid results and mismatched ids to malformed-response", async () => {
	for (const response of [
		(socket: net.Socket, request: { id: string | number }) =>
			socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { nope: true } })}\n`),
		(socket: net.Socket, request: { id: string | number }) =>
			socket.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: `${String(request.id)}-other`, result: { message: null } })}\n`,
			),
	]) {
		const peer = await socketServer(response);
		try {
			assert.deepEqual(await request(peer.socketPath), { ok: false, code: "malformed-response" });
		} finally {
			await peer.close();
		}
	}
});

test("last-message transport distinguishes offline, timeout, and abort", async () => {
	assert.deepEqual(await request(path.join(os.tmpdir(), `missing-last-message-${process.pid}.sock`)), {
		ok: false,
		code: "offline-member",
	});

	const hanging = await socketServer(() => {});
	try {
		assert.deepEqual(await request(hanging.socketPath, 10), { ok: false, code: "timeout" });
		const controller = new AbortController();
		const pending = request(hanging.socketPath, 5000, controller.signal);
		setImmediate(() => controller.abort());
		assert.deepEqual(await pending, { ok: false, code: "aborted" });
	} finally {
		await hanging.close();
	}
});

test("last-message transport maps a connected remote rejection without probing", async () => {
	const peer = await socketServer((socket, request) => {
		socket.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32000, message: "offline-member", data: { code: "offline-member" } },
			})}\n`,
		);
	});
	try {
		assert.deepEqual(await request(peer.socketPath), { ok: false, code: "offline-member" });
	} finally {
		await peer.close();
	}
});
