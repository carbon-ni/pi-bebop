import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleGetMessage } from "./get-message.ts";
test("get message returns null for an empty branch", async () => {
	const c = handlerContext();
	await handleGetMessage({ type: "get_message", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { message: null });
});

test("get message returns the latest assistant content", async () => {
	const c = handlerContext();
	c.ctx.sessionManager.getBranch = () =>
		[{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }] as never;
	await handleGetMessage({ type: "get_message", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { message: { role: "assistant", content: "hello", timestamp: 0 } });
});
