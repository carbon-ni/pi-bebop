import assert from "node:assert/strict";
import test from "node:test";
import {
	mapIdleWaitTransportError,
	normalizeIdleWaitErrorCode,
	normalizeIdleWaitTransportOutcome,
} from "./member-idle-wait-cli-transport.ts";

const result = {
	member: { name: "Bob", role: "developer" },
	outcome: "idle" as const,
	disposition: "became-idle" as const,
	observedAt: "2026-08-24T12:00:00.000Z",
};

test("member idle-wait CLI transport preserves stable mappings and closes unknown codes", () => {
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
	assert.deepEqual(mapIdleWaitTransportError(new Error("RPC request timeout")), { ok: false, code: "timeout" });
	assert.deepEqual(mapIdleWaitTransportError("other"), { ok: false, code: "transport-error" });
	assert.deepEqual(normalizeIdleWaitTransportOutcome({ ok: true, result }), { ok: true, result });
	assert.deepEqual(
		normalizeIdleWaitTransportOutcome({ ok: false, code: "transport-error", transportCode: "ENOENT" }),
		{ ok: false, code: "unknown-session" },
	);
	assert.equal(normalizeIdleWaitErrorCode("offline-session"), "offline-session");
	assert.equal(normalizeIdleWaitErrorCode("forged-code"), "unexpected-failure");
});
