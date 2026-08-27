import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleSubscribe } from "./subscribe.ts";
test("subscribe acknowledges turn-end and records a one-shot subscription", async () => {
	const c = handlerContext();
	await handleSubscribe({ type: "subscribe", event: "turn_end", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { subscriptionId: "test-id", event: "turn_end" });
	assert.equal(c.state.turnEndSubscriptions.length, 1);
});
test("subscribe rejects an unknown event", async () => {
	const c = handlerContext();
	await handleSubscribe({ type: "subscribe", event: "other" as never, id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "Unknown event type: other");
});
