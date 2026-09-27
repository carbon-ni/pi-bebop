import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import net from "node:net";
import { mkdir, rm, symlink, unlink } from "node:fs/promises";
import { CONTROL_DIR, getAliasPath, getSocketPath } from "../../infra/intray-paths.ts";
import {
	buildMemberLastMessageCommand,
	defaultMemberLastMessageCliDependencies,
	readMemberLastMessageCommand,
	runMemberLastMessageCommand,
	lastMessageThroughSdk,
} from "./member-last-message.ts";
import { UsageError } from "../support/arguments.ts";
import type { CliContext } from "../support/context.ts";
import { writeOutcome } from "../support/output.ts";
import type { BebopClient } from "../../sdk/index.ts";

function context(signal = new AbortController().signal): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal };
}

function parse(tokens: readonly string[]) {
	const command = buildMemberLastMessageCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return readMemberLastMessageCommand(command);
}

async function localSource(
	respond: (method: string) => { readonly result?: unknown; readonly error?: Record<string, unknown> } | undefined,
): Promise<{ session: string; requests: () => readonly string[]; close(): Promise<void> }> {
	await mkdir(CONTROL_DIR, { recursive: true });
	const session = `000last-message-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const socketPath = getSocketPath(session);
	const requests: string[] = [];
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			const request = JSON.parse(String(chunk)) as { id: string | number; method: string };
			requests.push(request.method);
			const response = respond(request.method);
			if (response) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		session,
		requests: () => requests,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		},
	};
}

test("last-message CLI validates target, session, and format", () => {
	const parsed = parse(["developer", "--session", "source-alias", "--format", "json"]);
	assert.equal(parsed.format, "json");
	assert.equal(parsed.session, "source-alias");
	assert.throws(() => parse([]), UsageError);
	assert.throws(() => parse(["developer", "--format", "yaml"]), UsageError);
	assert.throws(() => parse([" developer"]), UsageError);
	assert.throws(() => parse(["x".repeat(257)]), UsageError);
});

test("last-message CLI maps SDK errors and missing source", async () => {
	const failed = await runMemberLastMessageCommand(
		{ command: "member-last-message", member: "developer", format: "json" },
		context(),
		{
			resolveSource: () => ({
				ok: true,
				kind: "id",
				idSocketPath: "/tmp/source.sock",
				aliasSocketPath: "/tmp/source.sock",
			}),
			sendLastMessage: async () => ({ ok: false, code: "offline-session" }),
			environmentSession: () => undefined,
		},
	);
	assert.equal(failed.kind, "result");
	if (failed.kind === "result") assert.equal(failed.result.error?.code, "offline-session");

	await assert.rejects(
		runMemberLastMessageCommand(
			{ command: "member-last-message", member: "developer", format: "text" },
			context(),
			{
				resolveSource: () => ({ ok: false, message: "No source session" }),
				sendLastMessage: async () => ({ ok: false, code: "unreachable" }),
				environmentSession: () => undefined,
			},
		),
		UsageError,
	);
});

test("last-message CLI escapes terminal controls only in text output", async () => {
	const outcome = await runMemberLastMessageCommand(
		{ command: "member-last-message", member: "developer", format: "text" },
		context(),
		{
			resolveSource: () => ({
				ok: true,
				kind: "id",
				idSocketPath: "/tmp/source.sock",
				aliasSocketPath: "/tmp/source.sock",
			}),
			sendLastMessage: async () => ({
				ok: true,
				result: {
					member: { name: "developer", role: "Developer" },
					message: {
						role: "assistant",
						content: "safe\u001b[31m\u0007\u000d\u000a\u0085\u007f",
						timestamp: 1,
					},
				},
			}),
			environmentSession: () => undefined,
		},
	);
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => (text += chunk));
	assert.equal(writeOutcome(output, new PassThrough(), outcome), 0);
	assert.match(text, /safe\\u001B\[31m\\u0007\\u000D\n\\u0085\\u007F/);
	assert.doesNotMatch(text, /\x1b|\x07|\x0d/);
	assert.deepEqual(outcome.kind === "result" ? outcome.result.data : undefined, {
		member: { name: "developer", role: "Developer" },
		message: { role: "assistant", content: "safe\u001b[31m\u0007\u000d\u000a\u0085\u007f", timestamp: 1 },
	});
});

test("last-message CLI selects a source through an alias and maps peer errors", async () => {
	let memberResponse: { readonly result?: unknown; readonly error?: Record<string, unknown> } = {
		result: {
			member: { name: "developer", role: "Developer" },
			message: { role: "assistant", content: "latest", timestamp: 1 },
		},
	};
	const source = await localSource((method) =>
		method === "session.status" ? { result: { status: "joined", projectTrusted: true } } : memberResponse,
	);
	const alias = `last-message-cli-${process.pid}-${Date.now()}`;
	const aliasPath = getAliasPath(alias);
	await symlink(`${source.session}.sock`, aliasPath);
	try {
		const options = {
			command: "member-last-message" as const,
			member: "developer",
			session: alias,
			format: "json" as const,
		};
		const observed = await runMemberLastMessageCommand(options, context());
		assert.equal(observed.kind, "result");
		if (observed.kind === "result") assert.equal(observed.result.status, "observed");

		memberResponse = {
			error: { code: -32000, message: "offline-member", data: { code: "offline-member" } },
		};
		const rejected = await runMemberLastMessageCommand(options, context());
		assert.equal(rejected.kind, "result");
		if (rejected.kind === "result") assert.equal(rejected.result.error?.code, "offline-member");

		memberResponse = { result: { malformed: true } };
		const malformed = await runMemberLastMessageCommand(options, context());
		assert.equal(malformed.kind, "result");
		if (malformed.kind === "result") assert.equal(malformed.result.error?.code, "malformed-response");
	} finally {
		await unlink(aliasPath).catch(() => undefined);
		await source.close();
	}
});

test("last-message CLI uses SDK and preserves null history", async () => {
	const source = await localSource((method) =>
		method === "session.status"
			? { result: { status: "joined", projectTrusted: true } }
			: { result: { member: { name: "developer", role: "Developer" }, message: null } },
	);
	try {
		const outcome = await runMemberLastMessageCommand(
			{ command: "member-last-message", member: "developer", session: source.session, format: "json" },
			context(),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.deepEqual(outcome.result.data, {
			member: { name: "developer", role: "Developer" },
			message: null,
		});
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => (text += chunk));
		assert.equal(writeOutcome(output, new PassThrough(), outcome), 0);
		assert.match(text, /no assistant message recorded/);
	} finally {
		await source.close();
	}
});

test("last-message CLI SDK wrapper enforces its end-to-end deadline", async () => {
	const client = {
		selectSource: async () => ({
			getMemberLastMessage: async (_member: string, options?: { signal?: AbortSignal }) =>
				await new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		}),
	} as unknown as BebopClient;
	const result = await lastMessageThroughSdk("source", "developer", new AbortController().signal, client, 50);
	assert.deepEqual(result, { ok: false, code: "timeout" });
});

test("last-message CLI cancellation reaches the remote SDK operation", async () => {
	const source = await localSource((method) =>
		method === "session.status" ? { result: { status: "joined", projectTrusted: true } } : undefined,
	);
	const controller = new AbortController();
	try {
		const pending = runMemberLastMessageCommand(
			{ command: "member-last-message", member: "developer", session: source.session, format: "json" },
			context(controller.signal),
		);
		const deadline = Date.now() + 1000;
		while (!source.requests().includes("member.last_message_target") && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 1));
		assert.ok(source.requests().includes("member.last_message_target"));
		controller.abort();
		const outcome = await pending;
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "aborted");
		assert.equal(source.requests().filter((method) => method === "member.last_message_target").length, 1);
	} finally {
		await source.close();
	}
});
