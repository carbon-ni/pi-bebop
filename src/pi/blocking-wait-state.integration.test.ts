import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "./control-runtime.ts";
import { BlockingWaitSlot } from "../domain/index.ts";

/**
 * TASK-0117 real-socket integration: a joined trusted peer obtains the
 * bounded blocking-wait snapshot and exactly one transition notification over
 * the real RPC wire; disconnects clean up deterministically. No wait target,
 * message content, or session identity ever crosses the wire.
 */

const clock = () => {
	let tick = 0;
	return { now: () => new Date(1_700_000_000_000 + tick++ * 1_000).toISOString() };
};

interface LineClient {
	readonly socket: net.Socket;
	send(value: unknown): void;
	nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
	close(): void;
}

function lineClient(socketPath: string): Promise<LineClient> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const queue: string[] = [];
		const waiters: Array<(line: string) => void> = [];
		let buffer = "";
		socket.on("connect", () => {
			resolve({
				socket,
				send: (value) => socket.write(`${JSON.stringify(value)}\n`),
				nextMessage: (timeoutMs = 2_000) =>
					new Promise((resolveMessage, rejectMessage) => {
						const timer = setTimeout(() => rejectMessage(new Error("client read timeout")), timeoutMs);
						const deliver = (line: string) => {
							clearTimeout(timer);
							resolveMessage(JSON.parse(line));
						};
						const pending = queue.shift();
						if (pending !== undefined) deliver(pending);
						else waiters.push(deliver);
					}),
				close: () => socket.destroy(),
			});
		});
		socket.on("error", reject);
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line) {
					const waiter = waiters.shift();
					if (waiter) waiter(line);
					else queue.push(line);
				}
				index = buffer.indexOf("\n");
			}
		});
	});
}

test("peer snapshots wait state and receives exactly one transition notification over the wire", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-wait-state-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	const socketPath = path.join(root, "dave.sock");
	const state = createSocketState();
	state.blockingWait = new BlockingWaitSlot(clock());
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath,
			member: { name: "Dave", role: "dev", socketPath },
			manifest: {
				version: 1,
				presence: { notifications: true },
				members: [
					{ name: "Dave", role: "dev", socketPath },
					{ name: "Mony", role: "lead", socketPath: path.join(root, "mony.sock") },
				],
			},
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "dave", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const pi = { sendMessage: () => undefined, appendEntry: () => undefined } as never;
	const server = await createRpcServer(socketPath, (command, socket) => handleCommand(pi, state, command, socket));

	const client = await lineClient(socketPath);
	// One deterministic cleanup hook: the client connection must close before
	// closeRpcServer stops waiting for connections.
	t.after(async () => {
		client.close();
		await closeRpcServer(server);
	});

	client.send({ jsonrpc: "2.0", id: 41, method: "member.wait_state", params: { member: "Mony" } });
	const response = await client.nextMessage();
	assert.equal(response.error, undefined);
	const result = response.result as { subscriptionId: string; snapshot: { member: unknown; wait: unknown } };
	assert.equal(typeof result.subscriptionId, "string");
	assert.deepEqual(result.snapshot, { member: { name: "Dave", role: "dev" }, wait: null });

	// The observed member enters a blocking member idle wait -> one notification.
	assert.equal(state.blockingWait.acquire("member-idle").ok, true);
	const entered = await client.nextMessage();
	assert.equal(entered.method, "member.wait_state");
	const enteredParams = entered.params as { subscriptionId: string; snapshot: { wait: { kind: string } } };
	assert.equal(enteredParams.subscriptionId, result.subscriptionId);
	assert.equal(enteredParams.snapshot.wait.kind, "member-idle");
	// Privacy: no wait target, socket path, session id, or content on the wire.
	const wire = JSON.stringify(entered);
	assert.ok(!wire.includes("socket") && !wire.includes("sessionId") && !wire.includes("message"));

	// One-shot: the release transition produces no second notification.
	assert.equal(state.blockingWait.release(), true);
	await assert.rejects(() => client.nextMessage(300), /client read timeout/, "subscription consumed exactly once");
});

test("a disconnected subscriber is cleaned up and never crashes a later transition", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-wait-state-disc-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	const socketPath = path.join(root, "dave.sock");
	const state = createSocketState();
	state.blockingWait = new BlockingWaitSlot(clock());
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath,
			member: { name: "Dave", role: "dev", socketPath },
			manifest: {
				version: 1,
				presence: { notifications: true },
				members: [
					{ name: "Dave", role: "dev", socketPath },
					{ name: "Mony", role: "lead", socketPath: path.join(root, "mony.sock") },
				],
			},
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "dave", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const pi = { sendMessage: () => undefined, appendEntry: () => undefined } as never;
	const server = await createRpcServer(socketPath, (command, socket) => handleCommand(pi, state, command, socket));

	const client = await lineClient(socketPath);
	t.after(async () => {
		client.close();
		await closeRpcServer(server);
	});
	client.send({ jsonrpc: "2.0", id: 7, method: "member.wait_state", params: { member: "Mony" } });
	const response = await client.nextMessage();
	assert.equal(response.error, undefined);
	assert.equal(state.waitStateSubscriptions.length, 1);
	client.close();
	// Bounded wait: the server-side socket close event is asynchronous.
	const deadline = Date.now() + 2_000;
	while (state.waitStateSubscriptions.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(state.waitStateSubscriptions.length, 0, "disconnect removed the one-shot subscription");
	// Transition after disconnect is a clean no-op for the dead subscriber.
	assert.equal(state.blockingWait.acquire("member-idle").ok, true);
	assert.equal(state.blockingWait.release(), true);
});
