import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildMemberLastMessageCommand,
	defaultMemberLastMessageCliDependencies,
	readMemberLastMessageCommand,
	runMemberLastMessageCommand,
} from "./member-last-message.ts";
import { UsageError } from "../support/arguments.ts";
import type { CliContext } from "../support/context.ts";
import { writeOutcome } from "../support/output.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

function parse(tokens: readonly string[]) {
	const command = buildMemberLastMessageCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return readMemberLastMessageCommand(command);
}

test("last-message CLI validates target and format", () => {
	assert.equal(parse(["developer", "--format", "json"]).format, "json");
	assert.throws(() => parse([]), UsageError);
	assert.throws(() => parse(["developer", "--format", "yaml"]), UsageError);
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
	assert.match(text, /safe\\u001B\[31m\\u0007\\u000D\\u000A\\u0085\\u007F/);
	assert.doesNotMatch(text, /\x1b|\x07|\x0d/);
	assert.deepEqual(outcome.kind === "result" ? outcome.result.data : undefined, {
		member: { name: "developer", role: "Developer" },
		message: { role: "assistant", content: "safe\u001b[31m\u0007\u000d\u000a\u0085\u007f", timestamp: 1 },
	});
});

test("last-message CLI delegates over a real local socket and preserves null history", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-last-message-cli-"));
	const socketPath = path.join(dir, "source.sock");
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			const request = JSON.parse(String(chunk)) as { id: string | number };
			socket.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						member: { name: "developer", role: "Developer" },
						message: null,
					},
				})}\n`,
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const outcome = await runMemberLastMessageCommand(
			{ command: "member-last-message", member: "developer", format: "json" },
			context(),
			{
				...defaultMemberLastMessageCliDependencies,
				resolveSource: () => ({ ok: true, kind: "id", idSocketPath: socketPath, aliasSocketPath: socketPath }),
			},
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});
