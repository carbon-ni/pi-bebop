import assert from "node:assert/strict";
import test from "node:test";
import { sendRpcCommand } from "./rpc-client.ts";

test("sendRpcCommand preserves each caller abort reason before transport", async () => {
	for (const [signal, expected] of [
		[{ aborted: true, reason: new Error("caller stopped") }, "caller stopped"],
		[{ aborted: true, reason: "caller stopped" }, "caller stopped"],
		[{ aborted: true, reason: undefined }, "Operation aborted"],
	] as const) {
		await assert.rejects(
			sendRpcCommand("/definitely-missing.sock", { type: "status" }, { signal: signal as AbortSignal }),
			(error: Error) => error.message === expected,
		);
	}
});

test("sendRpcCommand fails closed when the endpoint is absent", async () => {
	await assert.rejects(
		sendRpcCommand("/definitely-missing.sock", { type: "status" }, { timeout: 50 }),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT" || error.code === "ECONNREFUSED",
	);
});
