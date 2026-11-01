import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requestMember } from "./client.ts";
import { durableSocketPath, type DurableMember } from "./member.ts";
import { runMemberServer } from "./server.ts";

test("send reports unanswered work as failure while preserving the retry ID and hiding provider detail", { timeout: 8_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bdp-outcome-"));
	const db = join(directory, "member.sqlite");
	const member: DurableMember = {
		conversationId: 1,
		resume: () => undefined,
		admit: async () => ({ submissionId: "1" }),
		admitInbox: async () => ({ submissionId: "1", requestId: "receipt" }),
		awaitSubmission: async () => ({ status: "unanswered", reason: "error" }),
		submit: async () => ({ status: "unanswered", reason: "error", detail: "private-provider-secret" }),
		close: async () => undefined,
	};
	const server = runMemberServer({ socketPath: await durableSocketPath(db), memberId: "designer", conversationId: 1, member });
	try {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const script = fileURLToPath(new URL("./main.ts", import.meta.url));
			const child = spawn(process.execPath, ["--experimental-strip-types", script, "send", "--db", db, "--member-id", "designer", "--request-id", "retry-17"], { stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, stdout, stderr }));
			child.stdin.end("hello");
		});

		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Request ID: retry-17/);
		assert.match(result.stderr, /Submission did not complete: unanswered \(error\)/);
		assert.doesNotMatch(result.stderr, /private-provider-secret/);
	} finally {
		try { await requestMember(db, { type: "stop" }); } catch {}
		await server;
		await rm(directory, { recursive: true, force: true });
	}
});
