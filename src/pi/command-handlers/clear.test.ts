import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleClear } from "./clear.ts";
test("clear rejects a busy context", async () => {
	const c = handlerContext();
	c.ctx.isIdle = () => false;
	await handleClear({ type: "clear", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "Session is busy - wait for turn to complete");
});
