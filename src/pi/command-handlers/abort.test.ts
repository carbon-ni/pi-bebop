import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleAbort } from "./abort.ts";
test("abort acknowledges and aborts the context", async () => {
	const c = handlerContext();
	let called = 0;
	c.ctx.abort = () => {
		called++;
	};
	await handleAbort({ type: "abort", id: "1" }, c);
	assert.equal(called, 1);
	assert.deepEqual((c.responses[0] as any).data, {});
});
