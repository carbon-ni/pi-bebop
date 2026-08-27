import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleInterrupt } from "./interrupt.ts";
test("interrupt rejects an invalid payload through the flow", async () => {
	const c = handlerContext();
	await handleInterrupt({ type: "interrupt", payload: {} as never, id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "invalid-payload");
});
