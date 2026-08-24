import assert from "node:assert/strict";
import test from "node:test";
import { parseMemberIdleWaitCommand, runMemberIdleWaitCommand } from "./member-idle-wait.ts";

const source = { ok: true as const, kind: "id" as const, idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" };
const result = {
	member: { name: "Bob", role: "developer" },
	outcome: "idle" as const,
	disposition: "became-idle" as const,
	observedAt: "2026-08-24T12:00:00.000Z",
};
const context = { cwd: process.cwd(), input: process.stdin, signal: new AbortController().signal };

test("member wait-idle parser accepts default and exact whole-second durations", () => {
	assert.equal(parseMemberIdleWaitCommand(["Bob"]).timeoutSeconds, 300);
	assert.equal(parseMemberIdleWaitCommand(["Bob", "--timeout", "1s"]).timeoutSeconds, 1);
	assert.equal(parseMemberIdleWaitCommand(["Bob", "--timeout", "10m"]).timeoutSeconds, 600);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "500ms"]), /whole-second/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "1500ms"]), /whole-second/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "11m"]), /whole-second/);
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

test("member wait-idle preserves aborted outcome and does not reinterpret it", async () => {
	const outcome = await runMemberIdleWaitCommand(parseMemberIdleWaitCommand(["Bob"]), context, {
		resolveSource: () => source,
		environmentSession: () => undefined,
		sendWait: async () => ({ ok: false, code: "aborted" }),
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "aborted");
});
