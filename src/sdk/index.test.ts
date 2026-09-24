import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { CONTROL_DIR, getAliasPath, getSocketPath } from "../infra/intray-paths.ts";
import { MAX_MESSAGE_PAYLOAD_BYTES, MAX_MESSAGE_ORIGIN_FIELD_BYTES } from "../domain/message-payload.ts";
import { BebopClientError, createBebopClient } from "./index.ts";

interface FakeSource {
	server: Server;
	session: string;
	requests: { method: string; params?: Record<string, unknown> }[];
	closedSockets: number;
	close(): Promise<void>;
}

async function waitForRequest(source: FakeSource, method: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!source.requests.some((request) => request.method === method)) {
		if (Date.now() >= deadline) throw new Error(`request not observed: ${method}`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

async function fakeSource(
	options: {
		trusted?: boolean;
		dropFollowUp?: boolean;
		dropInbox?: boolean;
		hangFollowUp?: boolean;
		hangInbox?: boolean;
		holdMemberStatus?: boolean;
		malformedStatus?: boolean;
		remoteError?: string;
		lastMessage?: { role: "assistant"; content: string; timestamp: number } | null;
	} = {},
): Promise<FakeSource> {
	await mkdir(CONTROL_DIR, { recursive: true });
	const session = `000sdk-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const socketPath = getSocketPath(session);
	const requests: FakeSource["requests"] = [];
	let closedSockets = 0;
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		socket.on("close", () => {
			closedSockets += 1;
		});
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
				if (
					(options.dropFollowUp && request.method === "member.follow_up") ||
					(options.dropInbox && request.method === "member.inbox_send")
				) {
					socket.destroy();
					return;
				}
				if (
					(options.hangFollowUp && request.method === "member.follow_up") ||
					(options.hangInbox && request.method === "member.inbox_send") ||
					(options.holdMemberStatus && request.method === "member.status_target")
				)
					return;
				if (options.remoteError && request.method !== "session.status") {
					socket.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							id: request.id,
							error: { code: -32000, message: options.remoteError, data: { code: options.remoteError } },
						})}\n`,
					);
					return;
				}
				const result =
					request.method === "session.status"
						? options.malformedStatus
							? { status: "joined", projectTrusted: false }
							: { status: "joined", ...(options.trusted === false ? {} : { projectTrusted: true }) }
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
							: request.method === "member.last_message_target"
								? {
										member: { name: "developer", role: "Developer" },
										message: options.lastMessage ?? null,
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
		get closedSockets() {
			return closedSockets;
		},
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		},
	};
}

test("SDK selects a trusted joined source and delegates status, Follow-up, and Inbox", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
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
			["session.status", "member.status_target", "member.follow_up", "member.inbox_send"],
		);
		assert.equal(source.requests[2]?.params?.target, "developer");
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

test("SDK delegates last assistant message snapshots and preserves empty history", async () => {
	const source = await fakeSource({
		lastMessage: { role: "assistant", content: "latest recorded text", timestamp: 1790100000000 },
	});
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		assert.deepEqual(await selected.getMemberLastMessage("developer"), {
			member: { name: "developer", role: "Developer" },
			message: { role: "assistant", content: "latest recorded text", timestamp: 1790100000000 },
		});
		assert.equal(source.requests.at(-1)?.method, "member.last_message_target");
	} finally {
		await source.close();
	}

	const empty = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: empty.session });
		assert.deepEqual((await selected.getMemberLastMessage("developer")).message, null);
	} finally {
		await empty.close();
	}
});

test("SDK preserves outcome-unknown for timeout after Follow-up and Inbox dispatch", async () => {
	const followUpSource = await fakeSource({ hangFollowUp: true });
	try {
		const selected = await createBebopClient().selectSource({ session: followUpSource.session });
		await assert.rejects(
			selected.sendFollowUp("developer", { message: "once" }, { timeoutMs: 50 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
		);
	} finally {
		await followUpSource.close();
	}

	const inboxSource = await fakeSource({ hangInbox: true });
	try {
		const selected = await createBebopClient().selectSource({ session: inboxSource.session });
		await assert.rejects(
			selected.sendToInbox("developer", { message: "once" }, { timeoutMs: 50 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
		);
	} finally {
		await inboxSource.close();
	}
});

test("SDK preserves outcome-unknown for AbortSignal cancellation after effect dispatch", async () => {
	const followUpSource = await fakeSource({ hangFollowUp: true });
	try {
		const selected = await createBebopClient().selectSource({ session: followUpSource.session });
		const controller = new AbortController();
		const pending = selected.sendFollowUp("developer", { message: "once" }, { signal: controller.signal });
		await waitForRequest(followUpSource, "member.follow_up");
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
		);
	} finally {
		await followUpSource.close();
	}

	const inboxSource = await fakeSource({ hangInbox: true });
	try {
		const selected = await createBebopClient().selectSource({ session: inboxSource.session });
		const controller = new AbortController();
		const pending = selected.sendToInbox("developer", { message: "once" }, { signal: controller.signal });
		await waitForRequest(inboxSource, "member.inbox_send");
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
		);
	} finally {
		await inboxSource.close();
	}
});

test("SDK keeps pre-dispatch cancellation distinct and performs no effect IO", async () => {
	const source = await fakeSource({ hangFollowUp: true, hangInbox: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const signal = AbortSignal.abort();
		await assert.rejects(
			Promise.resolve().then(() => selected.sendFollowUp("developer", { message: "once" }, { signal })),
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
		await assert.rejects(
			Promise.resolve().then(() => selected.sendToInbox("developer", { message: "once" }, { signal })),
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status"],
		);
	} finally {
		await source.close();
	}
});

test("SDK maps unknown, offline, malformed, and source target errors without leaking transport detail", async () => {
	await assert.rejects(
		createBebopClient().selectSource({ session: `missing-sdk-source-${process.pid}` }),
		(error: unknown) => error instanceof BebopClientError && error.code === "unknown-session",
	);

	const offline = await fakeSource();
	await new Promise<void>((resolve) => offline.server.close(() => resolve()));
	await writeFile(getSocketPath(offline.session), "stale socket path");
	try {
		await assert.rejects(
			createBebopClient().selectSource({ session: offline.session }),
			(error: unknown) => error instanceof BebopClientError && error.code === "offline-session",
		);
	} finally {
		await rm(getSocketPath(offline.session), { force: true });
	}

	const malformed = await fakeSource({ malformedStatus: true });
	try {
		await assert.rejects(
			createBebopClient().selectSource({ session: malformed.session }),
			(error: unknown) => error instanceof BebopClientError && error.code === "malformed-response",
		);
	} finally {
		await malformed.close();
	}

	const rejected = await fakeSource({ remoteError: "unknown-member" });
	try {
		const selected = await createBebopClient().selectSource({ session: rejected.session });
		await assert.rejects(
			selected.getMemberStatus("developer"),
			(error: unknown) => error instanceof BebopClientError && error.code === "unknown-member",
		);
	} finally {
		await rejected.close();
	}
});

test("SDK aborts an in-flight local-socket status request and the peer observes closure", async () => {
	const source = await fakeSource({ holdMemberStatus: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const controller = new AbortController();
		const pending = selected.getMemberStatus("developer", { signal: controller.signal });
		await waitForRequest(source, "member.status_target");
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
		const deadline = Date.now() + 1000;
		while (source.closedSockets === 0 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(source.closedSockets, 1);
	} finally {
		await source.close();
	}
});

test("SDK maps table-driven target rejection codes", async () => {
	for (const [remoteError, expected] of [
		["ambiguous-role", "ambiguous-member"],
		["self-query", "self-query"],
	] as const) {
		const source = await fakeSource({ remoteError });
		try {
			const selected = await createBebopClient().selectSource({ session: source.session });
			await assert.rejects(
				selected.getMemberStatus("developer"),
				(error: unknown) => error instanceof BebopClientError && error.code === expected,
			);
		} finally {
			await source.close();
		}
	}
});

test("SDK bounds discovery incrementally and closes its directory handle", async () => {
	const original = fs.opendir;
	let yielded = 0;
	let closed = false;
	fs.opendir = (async () => {
		let index = 0;
		const directory = {
			async next() {
				if (index >= 400) return { done: true as const, value: undefined };
				yielded += 1;
				return {
					done: false as const,
					value: { name: `entry-${index++}`, isDirectory: () => false, isSymbolicLink: () => false },
				};
			},
			[Symbol.asyncIterator]() {
				return this;
			},
			async close() {
				closed = true;
			},
		};
		return directory as never;
	}) as typeof fs.opendir;
	try {
		assert.deepEqual(await createBebopClient().listSources(), []);
		assert.equal(yielded, 400);
		assert.equal(closed, true);
	} finally {
		fs.opendir = original;
	}
});

test("SDK isolates concurrent status requests and closes all client transports", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const results = await Promise.all([
			selected.getMemberStatus("developer"),
			selected.getMemberStatus("developer"),
		]);
		assert.equal(results.length, 2);
		assert.equal(source.requests.filter((request) => request.method === "member.status_target").length, 2);
	} finally {
		await source.close();
	}
});

function maxSafeMessageLength(kind: "follow-up" | "inbox"): number {
	const escaped = "\x01".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES);
	const fits = (length: number) =>
		Buffer.byteLength(
			JSON.stringify({
				content: "x".repeat(length),
				origin: { kind: "crew", name: escaped, role: escaped },
				kind,
				sentAt: Number.MAX_SAFE_INTEGER,
			}),
			"utf8",
		) <= MAX_MESSAGE_PAYLOAD_BYTES;
	let low = 0;
	let high = MAX_MESSAGE_PAYLOAD_BYTES + 1;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle;
	}
	return low;
}

test("SDK validates exact aggregate payload boundaries before effect IO", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const followUpLength = maxSafeMessageLength("follow-up");
		await selected.sendFollowUp("developer", { message: "x".repeat(followUpLength) });
		const afterFollowUp = source.requests.length;
		await assert.rejects(
			Promise.resolve().then(() =>
				selected.sendFollowUp("developer", { message: "x".repeat(followUpLength + 1) }),
			),
			(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
		);
		assert.equal(source.requests.length, afterFollowUp);

		const inboxLength = maxSafeMessageLength("inbox");
		await selected.sendToInbox("developer", { message: "x".repeat(inboxLength) });
		const afterInbox = source.requests.length;
		await assert.rejects(
			Promise.resolve().then(() => selected.sendToInbox("developer", { message: "x".repeat(inboxLength + 1) })),
			(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
		);
		assert.equal(source.requests.length, afterInbox);
	} finally {
		await source.close();
	}
});

test("SDK races delayed opendir against the deadline and closes a late handle", async () => {
	const original = fs.opendir;
	let release: ((directory: never) => void) | undefined;
	let closed = false;
	fs.opendir = (() =>
		new Promise((resolve) => {
			release = resolve as (directory: never) => void;
		})) as typeof fs.opendir;
	try {
		const started = Date.now();
		await assert.rejects(
			createBebopClient().listSources({ timeoutMs: 50 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "timeout",
		);
		assert.ok(Date.now() - started < 500);
		release?.({
			async next() {
				return { done: true as const, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
			async close() {
				closed = true;
			},
		} as never);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(closed, true);
	} finally {
		fs.opendir = original;
	}
});

test("SDK races delayed alias realpath against the selection deadline", async () => {
	const source = await fakeSource();
	const alias = `sdk-timeout-alias-${process.pid}-${Date.now()}`;
	const aliasPath = getAliasPath(alias);
	await symlink(`${source.session}.sock`, aliasPath);
	const original = fs.realpath;
	fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		return original(...args);
	}) as typeof fs.realpath;
	try {
		await assert.rejects(
			createBebopClient().selectSource({ session: alias }, { timeoutMs: 50 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "timeout",
		);
	} finally {
		fs.realpath = original;
		await unlink(aliasPath).catch(() => undefined);
		await source.close();
	}
});

test("SDK chooses the same deterministic discovery subset regardless of enumeration order", async () => {
	const original = fs.opendir;
	const names = Array.from({ length: 300 }, (_, index) => `000sdk-order-${String(index).padStart(3, "0")}.sock`);
	const shuffled = [...names].reverse();
	fs.opendir = (async () => {
		let index = 0;
		return {
			async next() {
				if (index >= shuffled.length) return { done: true as const, value: undefined };
				const name = shuffled[index++];
				return { done: false as const, value: { name, isDirectory: () => false, isSymbolicLink: () => false } };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
			async close() {},
		} as never;
	}) as typeof fs.opendir;
	try {
		const sources = await createBebopClient().listSources();
		assert.deepEqual(
			sources.map((source) => source.session),
			names.slice(0, 100).map((name) => name.slice(0, -5)),
		);
	} finally {
		fs.opendir = original;
	}
});
