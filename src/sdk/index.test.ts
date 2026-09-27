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
		dropRedirect?: boolean;
		mismatchRedirect?: boolean;
		dropInbox?: boolean;
		dropBroadcast?: boolean;
		hangFollowUp?: boolean;
		hangRedirect?: boolean;
		hangInbox?: boolean;
		hangBroadcast?: boolean;
		holdMemberStatus?: boolean;
		holdLastMessage?: boolean;
		malformedStatus?: boolean;
		malformedLastMessage?: boolean;
		remoteError?: string;
		remoteErrorEnvelope?: "data-code" | "message-only";
		lastMessage?: { role: "assistant"; content: string; timestamp: number } | null;
		askWait?: (
			requestId: string,
			count: number,
		) => "pending" | "response" | "offline" | "timeout" | "malformed" | "mismatch";
		dropAskWait?: boolean;
		holdAskWait?: boolean;
	} = {},
): Promise<FakeSource> {
	await mkdir(CONTROL_DIR, { recursive: true });
	const session = `000sdk-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const socketPath = getSocketPath(session);
	const requests: FakeSource["requests"] = [];
	let closedSockets = 0;
	const askWaitCounts = new Map<string, number>();
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		socket.on("error", () => undefined);
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
					(options.dropRedirect && request.method === "member.redirect") ||
					(options.dropInbox && request.method === "member.inbox_send") ||
					(options.dropBroadcast && request.method === "crew.broadcast")
				) {
					socket.destroy();
					return;
				}
				if (
					(options.hangFollowUp && request.method === "member.follow_up") ||
					(options.hangRedirect && request.method === "member.redirect") ||
					(options.hangInbox && request.method === "member.inbox_send") ||
					(options.hangBroadcast && request.method === "crew.broadcast") ||
					(options.holdMemberStatus && request.method === "member.status_target") ||
					(options.holdLastMessage && request.method === "member.last_message_target")
				)
					return;
				if (options.remoteError && request.method !== "session.status") {
					const error =
						options.remoteErrorEnvelope === "message-only"
							? { code: -32000, message: options.remoteError }
							: {
									code: -32000,
									message:
										options.remoteErrorEnvelope === "data-code"
											? "source rejected"
											: options.remoteError,
									data: { code: options.remoteError },
								};
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error })}\n`);
					return;
				}
				if (request.method === "member.request_start") {
					socket.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							id: request.id,
							result: {
								accepted: true,
								requestId: `ask-${requests.filter((item) => item.method === "member.request_start").length}`,
								member: { name: "developer", role: "Developer" },
							},
						})}\n`,
					);
					continue;
				}
				if (request.method === "member.request_wait") {
					if (options.dropAskWait) {
						socket.destroy();
						return;
					}
					if (options.holdAskWait) return;
					const requestId = String(request.params?.requestId);
					const count = (askWaitCounts.get(requestId) ?? 0) + 1;
					askWaitCounts.set(requestId, count);
					const outcome = options.askWait?.(requestId, count) ?? "response";
					const resultRequestId = outcome === "mismatch" ? "ask-other" : requestId;
					const result =
						outcome === "pending"
							? {
									kind: "pending",
									requestId: resultRequestId,
									member: { name: "developer", role: "Developer" },
									reason: "pending-after-idle",
								}
							: outcome === "offline"
								? {
										kind: "offline",
										requestId: resultRequestId,
										member: { name: "developer", role: "Developer" },
									}
								: outcome === "timeout"
									? {
											kind: "timeout",
											requestId: resultRequestId,
											member: { name: "developer", role: "Developer" },
											reason: "max-wait",
										}
									: outcome === "malformed"
										? {
												kind: "response",
												requestId: resultRequestId,
												member: { name: "developer", role: "Developer" },
												message: "bad",
												instructions: "bad",
											}
										: {
												kind: "response",
												requestId: resultRequestId,
												member: { name: "developer", role: "Developer" },
												message: `answer-${requestId}`,
												instructions: ["ordered"],
											};
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
					continue;
				}
				const result =
					request.method === "member.respond"
						? {}
						: request.method === "session.status"
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
									? options.malformedLastMessage
										? { member: { name: "", role: "Developer" }, message: null }
										: {
												member: { name: "developer", role: "Developer" },
												message: options.lastMessage ?? null,
											}
									: request.method === "member.follow_up"
										? {
												member: { name: "developer", role: "Developer" },
												deliveryId: "delivery-1",
												disposition: "queued",
											}
										: request.method === "member.redirect"
											? {
													member: { name: "developer", role: "Developer" },
													deliveryId: "delivery-redirect",
													disposition: "steered",
												}
											: request.method === "crew.broadcast"
												? {
														dispositions: [
															{
																member: "developer",
																role: "Developer",
																disposition: "delivered",
																deliveryId: "broadcast-1",
															},
															{
																member: "reviewer",
																role: "Reviewer",
																disposition: "failed",
																code: "offline",
															},
														],
														summary: { delivered: 1, failed: 1, total: 2 },
													}
												: {
														member: { name: "developer", role: "Developer" },
														itemId: "item-1",
														persisted: true,
														hint: "skipped",
													};
				if (options.mismatchRedirect && request.method === "member.redirect") {
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "wrong-request-id", result })}\n`);
					continue;
				}
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

test("SDK selected source exposes real-wire Request start, repeat wait, and respond primitives", async () => {
	const source = await fakeSource({
		askWait: (_requestId, count) => (count === 1 ? "pending" : "response"),
	});
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const accepted = await selected.startMemberRequest("developer", {
			message: "Review this change",
			instructions: ["Check correlation"],
		});
		assert.deepEqual(accepted, {
			accepted: true,
			requestId: "ask-1",
			member: { name: "developer", role: "Developer" },
		});
		const pending = await selected.waitForRequestOutcome(accepted.requestId);
		assert.equal(pending.kind, "pending");
		const response = await selected.waitForRequestOutcome(accepted.requestId);
		assert.equal(response.kind, "response");
		if (response.kind === "response") {
			assert.equal(response.requestId, accepted.requestId);
			assert.deepEqual(response.instructions, ["ordered"]);
		}
		await selected.respondToMemberRequest(accepted.requestId, { message: "Acknowledged" });
		assert.deepEqual(
			source.requests
				.filter((request) => request.method.startsWith("member.request") || request.method === "member.respond")
				.map((request) => request.method),
			["member.request_start", "member.request_wait", "member.request_wait", "member.respond"],
		);
	} finally {
		await source.close();
	}
});

test("SDK selects a trusted joined source and delegates status, Follow-up, Redirect, Broadcast, and Inbox", async () => {
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
		assert.deepEqual(await selected.redirectMember("developer", { message: "change direction" }), {
			member: { name: "developer", role: "Developer" },
			deliveryId: "delivery-redirect",
			disposition: "steered",
		});
		assert.deepEqual(await selected.broadcastToCrew({ message: "crew update" }), {
			ok: true,
			dispositions: [
				{
					recipientName: "developer",
					recipientRole: "Developer",
					disposition: "delivered",
					deliveryId: "broadcast-1",
				},
				{
					recipientName: "reviewer",
					recipientRole: "Reviewer",
					disposition: "failed",
					code: "offline",
				},
			],
			summary: { delivered: 1, failed: 1, total: 2 },
		});
		assert.deepEqual(await selected.sendToInbox("developer", { message: "remember" }), {
			member: { name: "developer", role: "Developer" },
			itemId: "item-1",
			persisted: true,
			hint: "skipped",
		});
		assert.deepEqual(
			source.requests.map((request) => request.method),
			[
				"session.status",
				"member.status_target",
				"member.follow_up",
				"member.redirect",
				"crew.broadcast",
				"member.inbox_send",
			],
		);
		assert.equal(source.requests[2]?.params?.target, "developer");
		assert.deepEqual(source.requests[3]?.params, { target: "developer", message: "change direction" });
		assert.deepEqual(source.requests[4]?.params, { message: "crew update" });
	} finally {
		await source.close();
	}
});

test("SDK Redirect classifies a lost acknowledgement as unknown without retry", async () => {
	const source = await fakeSource({ dropRedirect: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(selected.redirectMember("developer", { message: "once" }), (error) => {
			assert.ok(error instanceof BebopClientError);
			assert.equal(error.code, "outcome-unknown");
			return true;
		});
		assert.equal(source.requests.filter((request) => request.method === "member.redirect").length, 1);
	} finally {
		await source.close();
	}
});

test("SDK Redirect preserves source rejection and validation behavior", async (t) => {
	for (const [remoteCode, expectedCode] of [
		["unknown-member", "unknown-member"],
		["offline-member", "offline-member"],
		["untrusted-project", "untrusted"],
	] as const) {
		await t.test(remoteCode, async () => {
			const source = await fakeSource({ remoteError: remoteCode });
			try {
				const selected = await createBebopClient().selectSource({ session: source.session });
				await assert.rejects(
					selected.redirectMember("developer", { message: "change direction" }),
					(error: unknown) => error instanceof BebopClientError && error.code === expectedCode,
				);
			} finally {
				await source.close();
			}
		});
	}
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(
			selected.redirectMember("developer", { message: "  " }),
			(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
		);
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status"],
		);
	} finally {
		await source.close();
	}
});

test("SDK Redirect maps a real-wire mismatched RPC id to malformed-response", async () => {
	const source = await fakeSource({ mismatchRedirect: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(
			selected.redirectMember("developer", { message: "change direction" }),
			(error: unknown) => error instanceof BebopClientError && error.code === "malformed-response",
		);
		assert.equal(source.requests.filter((request) => request.method === "member.redirect").length, 1);
	} finally {
		await source.close();
	}
});

test("SDK Redirect maps direct data.code and generic RPC remote-error envelopes", async (t) => {
	for (const [envelope, remoteCode, expectedCode] of [
		["data-code", "offline-member", "offline-member"],
		["message-only", "unknown-member", "unknown-member"],
	] as const) {
		await t.test(envelope, async () => {
			const source = await fakeSource({ remoteError: remoteCode, remoteErrorEnvelope: envelope });
			try {
				const selected = await createBebopClient().selectSource({ session: source.session });
				await assert.rejects(
					selected.redirectMember("developer", { message: "change direction" }),
					(error: unknown) => error instanceof BebopClientError && error.code === expectedCode,
				);
			} finally {
				await source.close();
			}
		});
	}
});

test("SDK Broadcast classifies a lost acknowledgement as unknown without retry", async () => {
	const source = await fakeSource({ dropBroadcast: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(selected.broadcastToCrew({ message: "once" }), (error) => {
			assert.ok(error instanceof BebopClientError);
			assert.equal(error.code, "outcome-unknown");
			return true;
		});
		assert.equal(source.requests.filter((request) => request.method === "crew.broadcast").length, 1);
	} finally {
		await source.close();
	}
});

test("SDK Broadcast preserves operation-specific remote results on the selected source", async (t) => {
	for (const code of ["no-recipients", "unknown-sender"] as const) {
		await t.test(code, async () => {
			const source = await fakeSource({ remoteError: code });
			try {
				const selected = await createBebopClient().selectSource({ session: source.session });
				assert.deepEqual(await selected.broadcastToCrew({ message: "crew update" }), { ok: false, code });
				assert.equal(source.requests.filter((request) => request.method === "crew.broadcast").length, 1);
			} finally {
				await source.close();
			}
		});
	}
});

test("SDK Broadcast maps direct RPC authority and validation rejections on the selected source", async (t) => {
	for (const [remoteCode, expectedCode] of [
		["not-joined", "not-joined"],
		["untrusted-project", "untrusted"],
		["invalid-input", "invalid-input"],
	] as const) {
		await t.test(remoteCode, async () => {
			const source = await fakeSource({ remoteError: remoteCode });
			try {
				const selected = await createBebopClient().selectSource({ session: source.session });
				await assert.rejects(
					selected.broadcastToCrew({ message: "crew update" }),
					(error: unknown) => error instanceof BebopClientError && error.code === expectedCode,
				);
			} finally {
				await source.close();
			}
		});
	}
});

test("SDK Follow-up preserves its operation-specific rejection mapping on the selected source", async () => {
	const source = await fakeSource({ remoteError: "self-send" });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(
			selected.sendFollowUp("developer", { message: "hello" }),
			(error: unknown) => error instanceof BebopClientError && error.code === "self-query",
		);
	} finally {
		await source.close();
	}
});

test("SDK Ask returns exactly the correlated Response and preserves instructions", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const result = await selected.ask(
			"developer",
			{ question: "Review this", instructions: ["first", "second"] },
			undefined,
		);
		assert.deepEqual(result, {
			status: "answered",
			code: "response",
			accepted: true,
			answered: true,
			safeRetry: false,
			member: { name: "developer", role: "Developer" },
			message: "answer-ask-1",
			instructions: ["ordered"],
		});
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status", "member.request_start", "member.request_wait"],
		);
		assert.equal(source.requests[1]?.params?.target, "developer");
		assert.equal(source.requests[1]?.params?.message, "Review this");
		assert.equal(source.requests[1]?.params?.timeoutSeconds, 30);
		assert.equal(source.requests[1]?.params?.maxWaitSeconds, 120);
		assert.deepEqual(source.requests[1]?.params?.instructions, ["first", "second"]);
		assert.equal("requestId" in (source.requests[1]?.params ?? {}), false);
	} finally {
		await source.close();
	}
});

test("SDK Ask re-waits the same hidden Request after nonterminal pending-after-idle", async () => {
	const source = await fakeSource({ askWait: (_requestId, count) => (count === 1 ? "pending" : "response") });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const result = await selected.ask(
			"developer",
			{ question: "Review this" },
			{ responseGraceSeconds: 1, totalWaitSeconds: 2 },
		);
		assert.equal(result.status, "answered");
		assert.deepEqual(
			source.requests
				.filter((request) => request.method === "member.request_wait")
				.map((request) => request.params?.requestId),
			["ask-1", "ask-1"],
		);
	} finally {
		await source.close();
	}
});

test("SDK Ask distinguishes accepted terminal outcomes and never marks them safe to retry", async () => {
	for (const [outcome, code] of [
		["offline", "offline-member"],
		["timeout", "timeout-total"],
	] as const) {
		const source = await fakeSource({ askWait: () => outcome });
		try {
			const selected = await createBebopClient().selectSource({ session: source.session });
			const result = await selected.ask(
				"developer",
				{ question: "Review this" },
				{ responseGraceSeconds: 1, totalWaitSeconds: 2 },
			);
			assert.equal(result.accepted, true);
			assert.equal(result.answered, false);
			assert.equal(result.safeRetry, false);
			assert.equal(result.code, code);
		} finally {
			await source.close();
		}
	}
});

test("SDK Ask validates bounded options and input before effect IO", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		for (const options of [
			{ responseGraceSeconds: 0, totalWaitSeconds: 2 },
			{ responseGraceSeconds: 30, totalWaitSeconds: 30 },
			{ responseGraceSeconds: 600, totalWaitSeconds: 600 },
		] as const) {
			await assert.rejects(
				Promise.resolve().then(() => selected.ask("developer", { question: "Review" }, options)),
				(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
			);
		}
		await assert.rejects(
			Promise.resolve().then(() => selected.ask("developer", { question: "   " }, { totalWaitSeconds: 2 })),
			(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
		);
		const boundary = await selected.ask(
			"developer",
			{ question: "Boundary" },
			{ responseGraceSeconds: 600, totalWaitSeconds: 1_800 },
		);
		assert.equal(boundary.status, "answered");
		assert.equal(source.requests.at(-2)?.params?.timeoutSeconds, 600);
		assert.equal(source.requests.at(-2)?.params?.maxWaitSeconds, 1_800);
	} finally {
		await source.close();
	}
});

test("SDK Ask rejects a valid but mismatched correlated Request outcome", async () => {
	const source = await fakeSource({ askWait: () => "mismatch" });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		await assert.rejects(
			selected.ask("developer", { question: "Review" }, { responseGraceSeconds: 1, totalWaitSeconds: 2 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "malformed-response",
		);
	} finally {
		await source.close();
	}
});

test("SDK Request wait rejects a valid but mismatched correlated outcome", async () => {
	const source = await fakeSource({ askWait: () => "mismatch" });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const accepted = await selected.startMemberRequest("developer", { message: "Review" });
		await assert.rejects(
			selected.waitForRequestOutcome(accepted.requestId),
			(error: unknown) => error instanceof BebopClientError && error.code === "malformed-response",
		);
	} finally {
		await source.close();
	}
});

test("SDK Ask reports timeout-total when its local budget expires after acceptance", async () => {
	const source = await fakeSource({ holdAskWait: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const result = await selected.ask(
			"developer",
			{ question: "Review" },
			{ responseGraceSeconds: 1, totalWaitSeconds: 2 },
		);
		assert.deepEqual(result, {
			status: "timeout",
			code: "timeout-total",
			accepted: true,
			answered: false,
			safeRetry: false,
			member: { name: "developer", role: "Developer" },
		});
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status", "member.request_start", "member.request_wait"],
		);
	} finally {
		await source.close();
	}
});

test("SDK Ask maps malformed and lost accepted routes without exposing transport detail", async () => {
	const malformed = await fakeSource({ askWait: () => "malformed" });
	try {
		const selected = await createBebopClient().selectSource({ session: malformed.session });
		await assert.rejects(
			selected.ask("developer", { question: "Review" }, { responseGraceSeconds: 1, totalWaitSeconds: 2 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "malformed-response",
		);
	} finally {
		await malformed.close();
	}

	const offline = await fakeSource({ askWait: () => "offline" });
	try {
		const selected = await createBebopClient().selectSource({ session: offline.session });
		const result = await selected.ask(
			"developer",
			{ question: "Review" },
			{ responseGraceSeconds: 1, totalWaitSeconds: 2 },
		);
		assert.equal(result.code, "offline-member");
	} finally {
		await offline.close();
	}

	const lost = await fakeSource({ dropAskWait: true });
	try {
		const selected = await createBebopClient().selectSource({ session: lost.session });
		await assert.rejects(
			selected.ask("developer", { question: "Review" }, { responseGraceSeconds: 1, totalWaitSeconds: 2 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "route-lost",
		);
	} finally {
		await lost.close();
	}
});

test("SDK Ask isolates concurrent correlated Requests", async () => {
	const source = await fakeSource();
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const results = await Promise.all([
			selected.ask("developer", { question: "one" }, { responseGraceSeconds: 1, totalWaitSeconds: 2 }),
			selected.ask("developer", { question: "two" }, { responseGraceSeconds: 1, totalWaitSeconds: 2 }),
		]);
		assert.deepEqual(
			results.map((result) => result.status),
			["answered", "answered"],
		);
		assert.deepEqual(
			results.map((result) => result.message),
			["answer-ask-1", "answer-ask-2"],
		);
	} finally {
		await source.close();
	}
});

test("SDK Ask does not claim a safe retry after cancellation of an accepted Request", async () => {
	const source = await fakeSource({ askWait: () => "pending" });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const controller = new AbortController();
		const pending = selected.ask(
			"developer",
			{ question: "Review" },
			{ responseGraceSeconds: 1, totalWaitSeconds: 2, signal: controller.signal },
		);
		await waitForRequest(source, "member.request_wait");
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
		);
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

test("SDK pins the validated canonical source when a managed alias is retargeted", async () => {
	const source = await fakeSource();
	const replacement = await fakeSource();
	const alias = `sdk-retarget-alias-${process.pid}-${Date.now()}`;
	const aliasPath = getAliasPath(alias);
	await symlink(`${source.session}.sock`, aliasPath);
	try {
		const selected = await createBebopClient().selectSource({ session: alias });
		await unlink(aliasPath);
		await symlink(`${replacement.session}.sock`, aliasPath);
		await selected.getMemberStatus("developer");
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status", "member.status_target"],
			"the selected source remains the canonical endpoint validated during selection",
		);
		assert.deepEqual(replacement.requests, [], "retargeted aliases cannot redirect an existing source client");
	} finally {
		await unlink(aliasPath).catch(() => undefined);
		await source.close();
		await replacement.close();
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

test("SDK maps last-message offline, size, and malformed-identity failures", async () => {
	for (const [remoteError, expected] of [
		["offline-member", "offline-member"],
		["message-too-large", "message-too-large"],
	] as const) {
		const source = await fakeSource({ remoteError });
		try {
			const selected = await createBebopClient().selectSource({ session: source.session });
			await assert.rejects(
				selected.getMemberLastMessage("developer"),
				(error: unknown) => error instanceof BebopClientError && error.code === expected,
			);
		} finally {
			await source.close();
		}
	}

	const malformed = await fakeSource({ malformedLastMessage: true });
	try {
		const selected = await createBebopClient().selectSource({ session: malformed.session });
		await assert.rejects(
			selected.getMemberLastMessage("developer"),
			(error: unknown) => error instanceof BebopClientError && error.code === "malformed-response",
		);
	} finally {
		await malformed.close();
	}
});

test("SDK denies last-message snapshot before target IO when source is untrusted", async () => {
	const source = await fakeSource({ trusted: false });
	try {
		await assert.rejects(
			createBebopClient().selectSource({ session: source.session }),
			(error: unknown) => error instanceof BebopClientError && error.code === "untrusted",
		);
		assert.deepEqual(
			source.requests.map((request) => request.method),
			["session.status"],
		);
	} finally {
		await source.close();
	}
});

test("SDK aborts a last-message snapshot request and closes the target socket", async () => {
	const source = await fakeSource({ holdLastMessage: true });
	try {
		const selected = await createBebopClient().selectSource({ session: source.session });
		const closedBefore = source.closedSockets;
		const controller = new AbortController();
		const pending = selected.getMemberLastMessage("developer", { signal: controller.signal });
		await waitForRequest(source, "member.last_message_target");
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
		const deadline = Date.now() + 1000;
		while (source.closedSockets <= closedBefore && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 1));
		assert.ok(source.closedSockets > closedBefore);
	} finally {
		await source.close();
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

test("SDK preserves typed Inbox remote rejection codes through the selected public source", async () => {
	const codes = [
		"inbox-full",
		"inbox-untrusted-path",
		"storage-unavailable",
		"storage-failed",
		"invalid-payload",
		"ambiguous-role",
		"self-send",
	] as const;
	for (const code of codes) {
		const source = await fakeSource({ remoteError: code });
		try {
			const selected = await createBebopClient().selectSource({ session: source.session });
			await assert.rejects(
				selected.sendToInbox("developer", { message: "durable" }),
				(error: unknown) => error instanceof BebopClientError && error.code === code,
			);
		} finally {
			await source.close();
		}
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

test("SDK does not await a held directory close after cancellation", async () => {
	const original = fs.opendir;
	let nextStarted!: () => void;
	let releaseNext!: () => void;
	let releaseClose!: () => void;
	let closeStarted!: () => void;
	const nextReady = new Promise<void>((resolve) => (nextStarted = resolve));
	const closeReady = new Promise<void>((resolve) => (closeStarted = resolve));
	fs.opendir = (async () => ({
		async next() {
			nextStarted();
			return new Promise<never>((resolve) => (releaseNext = () => resolve(undefined as never)));
		},
		[Symbol.asyncIterator]() {
			return this;
		},
		async close() {
			closeStarted();
			await new Promise<void>((resolve) => (releaseClose = resolve));
		},
	})) as typeof fs.opendir;
	const controller = new AbortController();
	try {
		const pending = createBebopClient().listSources({ signal: controller.signal, timeoutMs: 1_000 });
		await nextReady;
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
		await closeReady;
		releaseNext?.();
		releaseClose?.();
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
