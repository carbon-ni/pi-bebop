import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import {
	defaultMemberIdleWaitCliDependencies,
	mapIdleWaitTransportError,
	normalizeIdleWaitTransportOutcome,
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
