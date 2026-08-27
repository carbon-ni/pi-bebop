import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleInterrupt } from "./interrupt.ts";
test("interrupt rejects an invalid payload through the flow", async () => {
	const c = handlerContext();
	await handleInterrupt({ type: "interrupt", payload: {} as never, id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "invalid-payload");
});

test("interrupt returns a direct acknowledgement for a valid payload while idle", async () => {
	const c = handlerContext();
	let aborted = 0;
	c.ctx.abort = () => {
		aborted++;
	};
	await handleInterrupt(
		{
			type: "interrupt",
			payload: { content: "stop", instructions: ["step"], origin: { kind: "crew", name: "Mary", role: "po" } },
			id: "1",
		},
		c,
	);
	assert.equal(aborted, 0);
	assert.equal((c.responses[0] as any).success, undefined);
	assert.equal((c.responses[0] as any).data.disposition, "direct");
});
