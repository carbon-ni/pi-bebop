import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import {
	defaultMemberIdleWaitCliDependencies,
	mapIdleWaitTransportError,
	normalizeIdleWaitTransportOutcome,
	parseMemberIdleWaitCommand,
	runMemberIdleWaitCommand,
} from "./member-idle-wait.ts";

const source = { ok: true as const, kind: "id" as const, idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" };
const result = {
	member: { name: "Bob", role: "developer" },
	outcome: "idle" as const,
	disposition: "became-idle" as const,
	observedAt: "2026-08-24T12:00:00.000Z",
};
const context = { cwd: process.cwd(), input: process.stdin, signal: new AbortController().signal };

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

test("member wait-idle parser accepts default and exact whole-second durations", () => {
	assert.equal(parseMemberIdleWaitCommand(["Bob"]).timeoutSeconds, 300);
	assert.equal(parseMemberIdleWaitCommand(["Bob", "--timeout", "1s"]).timeoutSeconds, 1);
	assert.equal(parseMemberIdleWaitCommand(["Bob", "--timeout", "10m"]).timeoutSeconds, 600);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "500ms"]), /whole-second/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "1500ms"]), /whole-second/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "11m"]), /whole-second/);
});

test("member wait-idle parser covers help, duplicate, unknown, and target validation", () => {
	assert.equal(parseMemberIdleWaitCommand(["--help"]).help, true);
	assert.throws(() => parseMemberIdleWaitCommand(["--help", "--help"]), /Duplicate flag/);
	assert.throws(() => parseMemberIdleWaitCommand(["--bogus"]), /unknown option|Unknown flag/i);
	assert.throws(() => parseMemberIdleWaitCommand([]), /Missing <member>/);
	assert.throws(() => parseMemberIdleWaitCommand([" Bob"]), /trimmed/);
	assert.throws(() => parseMemberIdleWaitCommand(["x", "--format", "xml"]), /Invalid --format/);
	assert.throws(() => parseMemberIdleWaitCommand(["x", "--timeout", "0s"]), /Invalid --timeout/);
	assert.throws(() => parseMemberIdleWaitCommand(["x", "--timeout", "1s", "--timeout", "2s"]), /Duplicate flag/);
	assert.equal(parseMemberIdleWaitCommand(["Bob", "--session=s-1", "--timeout=1s", "--format=text"]).format, "text");
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--session", "a", "--session", "b"]), /Duplicate flag/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--format", "json", "--format", "text"]), /Duplicate flag/);
	assert.throws(() => parseMemberIdleWaitCommand(["x".repeat(257)]), /at most 256/);
});

test("member wait-idle delegates source selection and renders terminal result", async () => {
	let requested: { target: string; timeoutSeconds: number } | undefined;
	const outcome = await runMemberIdleWaitCommand(
		parseMemberIdleWaitCommand(["Bob", "--timeout", "30s", "--format", "json"]),
		context,
		{
			resolveSource: () => source,
			environmentSession: () => undefined,
			sendWait: async (_source, target, timeoutSeconds) => {
				requested = { target, timeoutSeconds };
				return { ok: true, result };
			},
		},
	);
	assert.deepEqual(requested, { target: "Bob", timeoutSeconds: 30 });
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.equal(outcome.format, "json");
		assert.deepEqual(outcome.result.data, { result });
	}
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
	const outcome = await runMemberIdleWaitCommand(parseMemberIdleWaitCommand(["Bob"]), context, {
		resolveSource: () => source,
		environmentSession: () => undefined,
		sendWait: async () => {
			throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
		},
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "offline-session");
});

test("member wait-idle maps source and malformed outcomes", async () => {
	const unresolved = await runMemberIdleWaitCommand(parseMemberIdleWaitCommand(["Bob"]), context, {
		resolveSource: () => ({ ok: false, code: "missing-session", message: "missing" }),
		environmentSession: () => undefined,
		sendWait: async () => ({ ok: true, result }),
	});
	assert.equal(unresolved.kind, "result");
	const malformed = await runMemberIdleWaitCommand(parseMemberIdleWaitCommand(["Bob"]), context, {
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
		const outcome = await runMemberIdleWaitCommand(parseMemberIdleWaitCommand(["Bob"]), context, {
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
	const outcome = await runMemberIdleWaitCommand(parseMemberIdleWaitCommand(["Bob"]), context, {
		resolveSource: () => source,
		environmentSession: () => undefined,
		sendWait: async () => ({ ok: false, code: "aborted" }),
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "aborted");
});
