import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { DurableMember } from "./member.ts";
import { durableSocketPath, memberRequestId } from "./member.ts";
import { requestMember } from "./client.ts";
import { runMemberServer } from "./server.ts";

const script = fileURLToPath(new URL("./main.ts", import.meta.url));

test("piped send reaches the local host with a stable member-scoped request key", { timeout: 8_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bdp-cli-"));
	const state = join(directory, "state");
	const workspace = join(directory, "workspace");
	const db = join(state, "member.sqlite");
	await mkdir(state, { mode: 0o700 });
	await mkdir(workspace);
	const socketPath = await durableSocketPath(db);
	let received: unknown;
	const member: DurableMember = {
		conversationId: 1,
		resume: () => undefined,
		submit: async (message, requestId) => {
			received = { message, requestId };
			return { status: "done", answer: "host received" };
		},
		admit: async () => ({ submissionId: "1" }),
		admitInbox: async (itemId, message, payloadHash) => ({
			submissionId: "1",
			requestId: `${itemId}:${payloadHash}:${message}`,
		}),
		awaitSubmission: async () => ({ status: "done", answer: "host received" }),
		close: async () => undefined,
	};
	const server = runMemberServer({ socketPath, memberId: "designer", conversationId: member.conversationId, member });
	try {
		const requestId = "cli-delivery-17";
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", script, "send", "--db", db, "--member-id", "designer", "--request-id", requestId], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, stdout, stderr }));
			child.stdin.end("hello from stdin");
		});
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /host received/);
		assert.deepEqual(received, {
			message: "hello from stdin",
			requestId: memberRequestId("designer", requestId),
		});
		const payloadHash = createHash("sha256").update('{"content":"inbox"}').digest("hex");
		const inboxAdmission = await requestMember(db, {
			type: "admitInbox",
			memberId: "designer",
			itemId: "inbox-1",
			message: "inbox message",
			payloadHash,
		});
		assert.equal(inboxAdmission.submissionId, "1");
	} finally {
		try { await requestMember(db, { type: "stop" }); } catch {}
		await server;
		await rm(directory, { recursive: true, force: true });
	}
});

test("submission client deadline allows model work longer than the control-socket deadline", { timeout: 5_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bdp-long-submit-"));
	const state = join(directory, "state");
	const db = join(state, "member.sqlite");
	await mkdir(state, { mode: 0o700 });
	let closed = false;
	const member: DurableMember = {
		conversationId: 1,
		resume: () => undefined,
		submit: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			return { status: "done", answer: "slow answer" };
		},
		admit: async () => ({ submissionId: "1" }),
		admitInbox: async () => ({ submissionId: "1", requestId: "bebop:receipt" }),
		awaitSubmission: async () => ({ status: "done", answer: "slow answer" }),
		close: async () => { closed = true; },
	};
	const server = runMemberServer({ socketPath: await durableSocketPath(db), memberId: "designer", conversationId: 1, member });
	try {
		const response = await requestMember(db, {
			type: "submit",
			memberId: "designer",
			message: "slow model request",
			requestId: "delivery-1",
		});
		assert.deepEqual(response.result, { status: "done", answer: "slow answer" });
	} finally {
		try { await requestMember(db, { type: "stop" }); } catch {}
		await server;
		await rm(directory, { recursive: true, force: true });
	}
	assert.equal(closed, true);
});
