import assert from "node:assert/strict";
import test from "node:test";
import { createModelDeliveryAdapter } from "./compaction-delivery.ts";

test("model delivery preserves complete message and delivery options while open", () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => {
		sent.push({ message, options });
	});
	const message = { customType: "crew", content: "hello", details: { messagePayload: { id: 1 } } };
	assert.deepEqual(adapter.send(message, { triggerTurn: true, deliverAs: "followUp" }), { disposition: "direct" });
	assert.deepEqual(sent, [{ message, options: { triggerTurn: true, deliverAs: "followUp" } }]);
});

test("model delivery defers Pi handoff until the terminal lifecycle task", async () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => sent.push({ message, options }));
	const generation = adapter.compactionStarted();
	const message = { customType: "crew", content: "deferred", details: { messagePayload: { id: 2 } } };
	assert.deepEqual(adapter.send(message, { triggerTurn: true }), { disposition: "deferred" });
	assert.deepEqual(sent, []);
	assert.equal(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, [{ message, options: { triggerTurn: true } }]);
});
