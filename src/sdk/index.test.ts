import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdir, rm, symlink, unlink } from "node:fs/promises";
import { CONTROL_DIR, getAliasPath, getSocketPath } from "../infra/intray-paths.ts";
import { BebopClientError, createBebopClient } from "./index.ts";

interface FakeSource {
	server: Server;
	session: string;
	requests: { method: string; params?: Record<string, unknown> }[];
	close(): Promise<void>;
}

async function fakeSource(options: { trusted?: boolean; dropFollowUp?: boolean } = {}): Promise<FakeSource> {
	await mkdir(CONTROL_DIR, { recursive: true });
	const session = `000sdk-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const socketPath = getSocketPath(session);
	const requests: FakeSource["requests"] = [];
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line) as {
					id: string | number;
					method: string;
					params?: Record<string, unknown>;
				};
				requests.push({ method: request.method, params: request.params });
				if (options.dropFollowUp && request.method === "member.follow_up") {
					socket.destroy();
					return;
				}
				const result =
					request.method === "session.status"
						? { status: "joined", ...(options.trusted === false ? {} : { projectTrusted: true }) }
						: request.method === "member.status_target"
							? {
									status: {
										member: { name: "developer", role: "Developer" },
										presence: "online",
										activity: "idle",
										hasPendingMessages: false,
										observedAt: "2026-09-22T20:00:00.000Z",
									},
								}
							: request.method === "member.follow_up"
								? {
										member: { name: "developer", role: "Developer" },
										deliveryId: "delivery-1",
										disposition: "queued",
									}
								: {
										member: { name: "developer", role: "Developer" },
										itemId: "item-1",
										persisted: true,
										hint: "skipped",
									};
				socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
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
	return {
		server,
		session,
		requests,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		},
	};
}

test("SDK selects a trusted joined source and delegates status, Follow-up, and Inbox", async () => {
	const source = await fakeSource();
	try {
		const client = createBebopClient();
		const sources = await client.listSources();
		assert.deepEqual(
			sources.find((entry) => entry.session === source.session),
			{
				session: source.session,
				aliases: [],
				state: "joined",
				trusted: true,
			},
		);
		const selected = await client.selectSource({ session: source.session });
		assert.deepEqual(await selected.getMemberStatus("developer"), {
			member: { name: "developer", role: "Developer" },
			presence: "online",
			activity: "idle",
			hasPendingMessages: false,
			observedAt: "2026-09-22T20:00:00.000Z",
		});
		assert.deepEqual(await selected.sendFollowUp("developer", { message: "hello", instructions: ["review"] }), {
			member: { name: "developer", role: "Developer" },
			deliveryId: "delivery-1",
			disposition: "queued",
		});
		assert.deepEqual(await selected.sendToInbox("developer", { message: "remember" }), {
			member: { name: "developer", role: "Developer" },
			itemId: "item-1",
			persisted: true,
			hint: "skipped",
		});
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status", "session.status", "member.status_target", "member.follow_up", "member.inbox_send"],
		);
		assert.equal(source.requests[3]?.params?.target, "developer");
	} finally {
		await source.close();
	}
});

test("SDK follows a managed alias without exposing its socket path", async () => {
	const source = await fakeSource();
	const alias = `sdk-alias-${process.pid}-${Date.now()}`;
	const aliasPath = getAliasPath(alias);
	await symlink(`${source.session}.sock`, aliasPath);
	try {
		await createBebopClient().selectSource({ session: alias });
	} finally {
		await unlink(aliasPath).catch(() => undefined);
		await source.close();
	}
});

test("SDK uses PI_SESSION_ID only as the explicit-selection convenience fallback", async () => {
	const source = await fakeSource();
	const previous = process.env.PI_SESSION_ID;
	process.env.PI_SESSION_ID = source.session;
	try {
		await createBebopClient().selectSource();
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_ID;
		else process.env.PI_SESSION_ID = previous;
		await source.close();
	}
});

test("SDK rejects an untrusted source and validates effects before socket IO", async () => {
	const source = await fakeSource({ trusted: false });
	try {
		await assert.rejects(
			createBebopClient().selectSource({ session: source.session }),
			(error: unknown) => error instanceof BebopClientError && error.code === "untrusted",
		);
		assert.equal(source.requests.length, 1);
	} finally {
		await source.close();
	}
	await assert.rejects(
		createBebopClient().listSources({ signal: AbortSignal.abort() }),
		(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
	);
});

test("SDK reports outcome-unknown after a dispatched Follow-up loses its acknowledgement", async () => {
	const source = await fakeSource({ dropFollowUp: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(
			selected.sendFollowUp("developer", { message: "once" }),
			(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
		);
		assert.equal(source.requests.filter((request) => request.method === "member.follow_up").length, 1);
	} finally {
		await source.close();
	}
});

test("SDK rejects invalid message input without opening the source socket", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(
			Promise.resolve().then(() => selected.sendToInbox("developer", { message: "   " })),
			(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
		);
		assert.equal(source.requests.length, 1);
	} finally {
		await source.close();
	}
});
