import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleSend } from "./send.ts";
test("send rejects an invalid structured payload", async () => {
	const c = handlerContext();
	await handleSend({ type: "send", payload: {} as never, id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "Invalid structured message payload");
});
