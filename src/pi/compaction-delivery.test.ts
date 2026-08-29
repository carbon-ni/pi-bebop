import assert from "node:assert/strict";
import test from "node:test";
import { createModelDeliveryAdapter } from "./compaction-delivery.ts";

test("model delivery persists and acknowledges a deferred handoff", async () => {
	const sent: unknown[] = [];
	const calls: string[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => {
			calls.push(`append:${envelope.id}`);
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: 1,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async (id: string) => void calls.push(`handoff:${id}`),
		markDelivered: async (id: string) => void calls.push(`delivered:${id}`),
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	assert.deepEqual(adapter.send({ customType: "crew", content: "deferred" }), { disposition: "deferred" });
	assert.equal(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sent.length, 1);
	assert.deepEqual(
		calls.map((call) => call.split(":")[0]),
		["append", "handoff", "delivered"],
	);
});

test("model delivery preserves complete message and delivery options while open", () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => {
		sent.push({ message, options });
	});
	const message = { customType: "crew", content: "hello", details: { messagePayload: { id: 1 } } };
	assert.deepEqual(adapter.send(message, { triggerTurn: true, deliverAs: "followUp" }), { disposition: "direct" });
	assert.deepEqual(sent, [{ message, options: { triggerTurn: true, deliverAs: "followUp" } }]);
});

test("model delivery rejects unserializable envelopes without sending", () => {
	const adapter = createModelDeliveryAdapter(() => assert.fail("must not send"));
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.deepEqual(adapter.send(circular), { disposition: "invalid" });
});

test("model delivery resolves sendAndWait only after deferred handoff", async () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => sent.push({ message, options }));
	const generation = adapter.compactionStarted();
	let settled = false;
	const completion = adapter
		.sendAndWait({ customType: "crew", content: "request" }, { triggerTurn: true })
		.then(() => {
			settled = true;
		});
	assert.equal(settled, false);
	assert.deepEqual(adapter.compactionEnded(generation), true);
	await completion;
	assert.equal(settled, true);
	assert.equal(sent.length, 1);
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
