import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleStatus } from "./status.ts";
test("status reports the online state", async () => {
	const c = handlerContext();
	c.state.server = {} as never;
	await handleStatus({ type: "status", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { status: "online" });
});

test("status reports stopped when the control server is absent", async () => {
	const c = handlerContext();
	await handleStatus({ type: "status", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { status: "stopped" });
});
