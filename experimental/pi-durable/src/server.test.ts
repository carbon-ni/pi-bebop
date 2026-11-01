import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import test from "node:test";
import type { DurableMember } from "./member.ts";
import { runMemberServer } from "./server.ts";

function connect(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function requestSocket(path: string, request: unknown): Promise<Record<string, unknown>> {
	return new Promise(async (resolve, reject) => {
		try {
			const socket = await connect(path);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				socket.end();
				try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
			});
			socket.once("error", reject);
			socket.write(`${JSON.stringify(request)}\n`);
		} catch (error) {
			reject(error);
		}
	});
}

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 3_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		try { return await operation(); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
	throw new Error("condition did not become true before timeout");
}

test("disconnecting a local client does not cancel member-owned submission work", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-server-"));
	const socketPath = join(directory, "member.sock");
	let finishSubmission!: () => void;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let closed = false;
	let completed = false;
	let markCompleted!: () => void;
	const submissionCompleted = new Promise<void>((resolve) => (markCompleted = resolve));
	const member: DurableMember = {
		conversationId: 1,
		resume: () => undefined,
		submit: async () => {
			markStarted();
			await new Promise<void>((resolve) => (finishSubmission = resolve));
			completed = true;
			markCompleted();
			return { status: "done", answer: "finished" };
		},
		admit: async () => ({ submissionId: "7" }),
		admitInbox: async () => ({ submissionId: "7", requestId: "bebop:receipt" }),
		awaitSubmission: async () => ({ status: "done", answer: "finished" }),
		close: async () => { closed = true; },
	};
	const server = runMemberServer({ socketPath, memberId: "designer", conversationId: member.conversationId, member });
	try {
		await eventually(() => requestSocket(socketPath, { type: "status" }));
		const socket = await connect(socketPath);
		socket.write('{"type":"submit","memberId":"designer","message":"hello","requestId":"r1"}\n');
		await started;
		socket.destroy();
		finishSubmission();
		await submissionCompleted;
		const status = await requestSocket(socketPath, { type: "status" });
		assert.equal(status.status, "running");
	} finally {
		try { await requestSocket(socketPath, { type: "stop" }); } catch {}
		await server;
		await rm(directory, { recursive: true, force: true });
	}
	assert.equal(closed, true);
	assert.equal(completed, true);
});

test("runs the trusted startup hook after listening and before Durable resume", { timeout: 5_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-ready-"));
	const socketPath = join(directory, "member.sock");
	const order: string[] = [];
	const member: DurableMember = {
		conversationId: 1,
		resume: () => { order.push("resume"); },
		submit: async () => ({ status: "done" }),
		admit: async () => ({ submissionId: "1" }),
		admitInbox: async () => ({ submissionId: "1", requestId: "bebop:receipt" }),
		awaitSubmission: async () => ({ status: "done" }),
		close: async () => undefined,
	};
	const server = runMemberServer({
		socketPath,
		memberId: "designer",
		conversationId: member.conversationId,
		member,
					onListening: async () => {
			const status = await requestSocket(socketPath, { type: "status" });
			assert.equal(status.status, "initializing");
			const earlyRequest = await requestSocket(socketPath, {
				type: "submit", memberId: "designer", message: "too early", requestId: "r0",
			});
			assert.equal(earlyRequest.ok, false);
			order.push("claimed");
			member.resume();
		},
	});
	try {
		await eventually(() => requestSocket(socketPath, { type: "status" }));
		assert.deepEqual(order, ["claimed", "resume"]);
	} finally {
		await requestSocket(socketPath, { type: "stop" });
		await server;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects startup-hook failures through the server promise", { timeout: 5_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-startup-failure-"));
	const socketPath = join(directory, "member.sock");
	const member: DurableMember = {
		conversationId: 1,
		resume: () => undefined,
		submit: async () => ({ status: "done" }),
		admit: async () => ({ submissionId: "1" }),
		admitInbox: async () => ({ submissionId: "1", requestId: "bebop:receipt" }),
		awaitSubmission: async () => ({ status: "done" }),
		close: async () => undefined,
	};
	await assert.rejects(
		runMemberServer({
			socketPath,
			memberId: "designer",
			conversationId: 1,
			member,
			onListening: async () => { throw new Error("trusted startup failed"); },
		}),
		/trusted startup failed/,
	);
	await rm(directory, { recursive: true, force: true });
});

test("stop closes stalled client connections before closing the member",   { timeout: 5_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-stop-"));
	const socketPath = join(directory, "member.sock");
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let closeStarted = false;
	let shutdownTimedOut = false;
	const member: DurableMember = {
		conversationId: 1,
		resume: () => undefined,
		submit: async () => {
			markStarted();
			return new Promise(() => undefined);
		},
		admit: async () => ({ submissionId: "7" }),
		admitInbox: async () => ({ submissionId: "7", requestId: "bebop:receipt" }),
		awaitSubmission: async () => new Promise(() => undefined),
		close: async () => {
			closeStarted = true;
			return new Promise<void>(() => undefined);
		},
	};
	const server = runMemberServer({
		socketPath,
		memberId: "designer",
		conversationId: member.conversationId,
		member,
		shutdownGraceMs: 20,
		onShutdownTimeout: () => { shutdownTimedOut = true; },
	});
	let pendingClient: Socket | undefined;
	try {
		await eventually(() => requestSocket(socketPath, { type: "status" }));
		pendingClient = await connect(socketPath);
		pendingClient.write('{"type":"submit","memberId":"designer","message":"stalled","requestId":"r1"}\n');
		await started;

		const stopped = await requestSocket(socketPath, { type: "stop" });
		assert.equal(stopped.status, "stopping");
		await server;
		assert.equal(closeStarted, true);
		assert.equal(shutdownTimedOut, true);
	} finally {
		pendingClient?.destroy();
		if (!closeStarted) await requestSocket(socketPath, { type: "stop" }).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});
