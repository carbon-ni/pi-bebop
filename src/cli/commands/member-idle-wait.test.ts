import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import { Command } from "commander";
import { UsageError } from "../support/arguments.ts";
import {
	buildMemberIdleWaitCommand,
	defaultMemberIdleWaitCliDependencies,
	mapIdleWaitTransportError,
	normalizeIdleWaitTransportOutcome,
	readMemberIdleWaitCommand,
	runMemberIdleWaitCommand,
} from "./member-idle-wait.ts";

function parseInto(tokens: readonly string[]): Command {
	const command = buildMemberIdleWaitCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return command;
}
function waitOptions(tokens: readonly string[] = ["Bob"]) {
	return readMemberIdleWaitCommand(parseInto(tokens));
}

const source = { ok: true as const, kind: "id" as const, idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" };
const result = {
	member: { name: "Bob", role: "developer" },
	outcome: "idle" as const,
	disposition: "became-idle" as const,
	observedAt: "2026-08-24T12:00:00.000Z",
};
const context = { cwd: process.cwd(), input: process.stdin, signal: new AbortController().signal };

test("idle wait dependencies read explicit environment sessions and process fallback", () => {
	assert.equal(defaultMemberIdleWaitCliDependencies.environmentSession({ PI_SESSION_ID: "env-1" }), "env-1");
	const processSession = defaultMemberIdleWaitCliDependencies.environmentSession();
	assert.ok(processSession === undefined || typeof processSession === "string");
});

test("idle wait reader validates member, format, and whole-second timeout", () => {
	assert.deepEqual(waitOptions(["Bob", "--timeout", "10s", "--format", "text"]), {
		command: "member-idle-wait",
		member: "Bob",
		timeoutSeconds: 10,
		format: "text",
	});
	for (const tokens of [
		["--format", "yaml", "Bob"],
		["Bob", "--timeout", "0s"],
		["Bob", "--timeout", "1500ms"],
		["Bob", "--timeout", "11m"],
		["Bob", "--timeout", "bad"],
		[" Bob"],
		[],
	] as const)
		assert.throws(() => waitOptions(tokens));
});

test("idle transport mappers cover every stable error and normalized transport code", () => {
	assert.deepEqual(mapIdleWaitTransportError(Object.assign(new Error("abort"), { name: "AbortError" })), {
		ok: false,
		code: "aborted",
	});
	assert.deepEqual(mapIdleWaitTransportError(Object.assign(new Error("missing"), { code: "ENOENT" })), {
		ok: false,
		code: "unknown-session",
	});
	assert.deepEqual(mapIdleWaitTransportError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), {
		ok: false,
		code: "offline-session",
	});
	assert.deepEqual(mapIdleWaitTransportError(Object.assign(new Error("not connected"), { code: "ENOTCONN" })), {
		ok: false,
		code: "offline-session",
	});
	assert.deepEqual(mapIdleWaitTransportError(new Error("RPC request timeout")), { ok: false, code: "timeout" });
	assert.deepEqual(mapIdleWaitTransportError(new Error("other")), { ok: false, code: "transport-error" });
	assert.deepEqual(mapIdleWaitTransportError("other"), { ok: false, code: "transport-error" });
	assert.deepEqual(normalizeIdleWaitTransportOutcome({ ok: true, result }), { ok: true, result });
	for (const transportCode of ["ENOENT", "ECONNREFUSED", "ENOTCONN"] as const)
		assert.deepEqual(normalizeIdleWaitTransportOutcome({ ok: false, code: "transport-error", transportCode }), {
			ok: false,
			code: transportCode === "ENOENT" ? "unknown-session" : "offline-session",
		});
	assert.deepEqual(normalizeIdleWaitTransportOutcome({ ok: false, code: "timeout" }), { ok: false, code: "timeout" });
	assert.deepEqual(
		normalizeIdleWaitTransportOutcome({ ok: false, code: "transport-error", transportCode: "OTHER" } as never),
		{
			ok: false,
			code: "transport-error",
			transportCode: "OTHER",
		},
	);
});

test("default wait transport falls back from stale id socket to a valid alias", async () => {
	const idSocketPath = `/tmp/pi-bebop-stale-${process.pid}-${Date.now()}.sock`;
	const aliasSocketPath = `/tmp/pi-bebop-alias-${process.pid}-${Date.now()}.sock`;
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			const line = buffer.split("\n")[0];
			if (!line) return;
			const request = JSON.parse(line) as { id: string | number };
			socket.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: { subscriptionId: String(request.id), event: "member_idle" },
				}) + "\n",
			);
			socket.write(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "member.idle_wait",
					params: {
						subscriptionId: String(request.id),
						result: {
							member: { name: "Bob", role: "developer" },
							outcome: "idle",
							disposition: "became-idle",
							observedAt: "2026-08-24T12:00:00.000Z",
						},
					},
				}) + "\n",
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(aliasSocketPath, resolve));
	try {
		const outcome = await defaultMemberIdleWaitCliDependencies.sendWait(
			{ ...source, idSocketPath, aliasSocketPath },
			"Bob",
			1,
			new AbortController().signal,
		);
		assert.equal(outcome.ok, true);
		if (outcome.ok) assert.equal(outcome.result.outcome, "idle");
		const primary = await defaultMemberIdleWaitCliDependencies.sendWait(
			{ ...source, idSocketPath: aliasSocketPath, aliasSocketPath },
			"Bob",
			1,
			new AbortController().signal,
		);
		assert.equal(primary.ok, true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("default wait transport maps unavailable source errors without rejecting", async () => {
	const outcome = await defaultMemberIdleWaitCliDependencies.sendWait(
		{
			...source,
			idSocketPath: "/tmp/pi-bebop-missing-id.sock",
			aliasSocketPath: "/tmp/pi-bebop-missing-alias.sock",
		},
		"Bob",
		1,
		new AbortController().signal,
	);
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.code, "unknown-session");
});

test("member wait-idle maps rejected transport promises instead of rejecting", async () => {
	const outcome = await runMemberIdleWaitCommand(waitOptions(), context, {
		resolveSource: () => source,
		environmentSession: () => undefined,
		sendWait: async () => {
			throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
		},
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "offline-session");
});

test("member wait-idle source resolution failures are usage-class", async () => {
	await assert.rejects(
		() =>
			runMemberIdleWaitCommand(waitOptions(), context, {
				resolveSource: () => ({ ok: false, code: "missing-session", message: "missing" }),
				environmentSession: () => undefined,
				sendWait: async () => ({ ok: true, result }),
			}),
		(error: unknown) => error instanceof UsageError && error.message === "missing",
	);
	await assert.rejects(
		() =>
			runMemberIdleWaitCommand(waitOptions(), context, {
				resolveSource: () => ({ ok: false, code: "missing-session" }),
				environmentSession: () => undefined,
				sendWait: async () => ({ ok: true, result }),
			}),
		(error: unknown) => error instanceof UsageError && /Unable to resolve/.test(error.message),
	);
	const malformed = await runMemberIdleWaitCommand(waitOptions(), context, {
		resolveSource: () => source,
		environmentSession: () => undefined,
		sendWait: async () => ({ ok: true, result: { ...result, outcome: "not-an-outcome" } as never }),
	});
	assert.equal(malformed.kind, "result");
	if (malformed.kind === "result") assert.equal(malformed.result.error?.code, "malformed-response");
});

test("member wait-idle maps thrown transport errors deterministically", async () => {
	for (const [error, code] of [
		[Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "offline-session"],
		[Object.assign(new Error("not connected"), { code: "ENOTCONN" }), "offline-session"],
		[new Error("RPC request timeout"), "timeout"],
		[Object.assign(new Error("abort"), { name: "AbortError" }), "aborted"],
	] as const) {
		const outcome = await runMemberIdleWaitCommand(waitOptions(), context, {
			resolveSource: () => source,
			environmentSession: () => undefined,
			sendWait: async () => {
				throw error;
			},
		});
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.equal(outcome.result.error?.code, code);
	}
});

test("member wait-idle preserves aborted outcome and does not reinterpret it", async () => {
	const outcome = await runMemberIdleWaitCommand(waitOptions(), context, {
		resolveSource: () => source,
		environmentSession: () => undefined,
		sendWait: async () => ({ ok: false, code: "aborted" }),
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "aborted");
});
