import test from "node:test";
import assert from "node:assert/strict";
import { createCompactionDeliveryGate, type CompactionDeliveryEnvelope } from "./compaction-delivery-gate.ts";

const envelope = (id: string, bytes = 1): CompactionDeliveryEnvelope => ({
	id,
	bytes,
	message: id,
	delivery: { triggerTurn: true },
	metadata: { surface: "test", deliveryId: id },
});

function setup(options: { maxEntries?: number; maxBytes?: number } = {}) {
	const scheduled: Array<() => void> = [];
	const delivered: string[] = [];
	const gate = createCompactionDeliveryGate({
		maxEntries: options.maxEntries ?? 64,
		maxBytes: options.maxBytes ?? 70_400_000,
		schedule: (task) => scheduled.push(task),
		deliver: (entry) => {
			delivered.push(entry.id);
			return undefined;
		},
	});
	return { gate, scheduled, delivered };
}

test("delivers immediately while open", () => {
	const { gate, delivered } = setup();
	assert.deepEqual(gate.accept(envelope("direct")), { disposition: "direct" });
	assert.deepEqual(delivered, ["direct"]);
});

test("defers during compaction and drains once after the terminal task", () => {
	const { gate, scheduled, delivered } = setup();
	const generation = gate.compactionStarted();
	assert.deepEqual(gate.accept(envelope("deferred")), { disposition: "deferred" });
	assert.deepEqual(delivered, []);
	assert.equal(gate.compactionEnded(generation), true);
	assert.equal(scheduled.length, 1);
	scheduled.shift()!();
	assert.deepEqual(delivered, ["deferred"]);
	assert.equal(gate.pendingCount(), 0);
});

test("failed terminal drains only after the matching compaction depth closes", () => {
	const { gate, scheduled, delivered } = setup();
	const generation = gate.compactionStarted();
	gate.accept(envelope("failed"));
	assert.equal(gate.compactionEnded(generation), true);
	scheduled.shift()!();
	assert.deepEqual(delivered, ["failed"]);
});

test("nested compaction requires matching depth and current generation before drain", () => {
	const { gate, scheduled, delivered } = setup();
	const outer = gate.compactionStarted();
	const inner = gate.compactionStarted();
	gate.accept(envelope("nested"));
	assert.equal(gate.compactionEnded(outer), false);
	assert.equal(scheduled.length, 0);
	assert.equal(gate.compactionEnded(inner), true);
	assert.equal(scheduled.length, 0);
	assert.equal(gate.compactionEnded(outer), true);
	assert.equal(scheduled.length, 1);
	scheduled.shift()!();
	assert.deepEqual(delivered, ["nested"]);
});

test("stale terminal does not schedule a drain", () => {
	const { gate, scheduled, delivered } = setup();
	const first = gate.compactionStarted();
	gate.accept(envelope("kept"));
	gate.compactionStarted();
	assert.equal(gate.compactionEnded(first), false);
	assert.equal(scheduled.length, 0);
	assert.deepEqual(delivered, []);
});

test("a direct message cannot overtake an older pending entry", () => {
	const { gate, scheduled, delivered } = setup();
	const generation = gate.compactionStarted();
	gate.accept(envelope("old"));
	gate.compactionEnded(generation);
	assert.deepEqual(gate.accept(envelope("new")), { disposition: "deferred" });
	scheduled.shift()!();
	assert.deepEqual(delivered, ["old", "new"]);
});

test("capacity rejects newest entry atomically", () => {
	const { gate, scheduled, delivered } = setup({ maxEntries: 1, maxBytes: 2 });
	gate.compactionStarted();
	assert.deepEqual(gate.accept(envelope("one", 2)), { disposition: "deferred" });
	assert.deepEqual(gate.accept(envelope("two", 1)), { disposition: "capacity-exceeded" });
	assert.equal(gate.pendingCount(), 1);
	assert.deepEqual(delivered, []);
	assert.equal(scheduled.length, 0);
});

test("a replay-blocked head holds later entries until explicit recovery", () => {
	const sent: string[] = [];
	const gate = createCompactionDeliveryGate({
		maxEntries: 4,
		maxBytes: 100,
		schedule: (task) => task(),
		deliver: (entry) => sent.push(entry.id),
	});
	gate.hold();
	assert.deepEqual(gate.accept(envelope("blocked", 1)), { disposition: "deferred" });
	assert.deepEqual(gate.accept(envelope("later", 1)), { disposition: "deferred" });
	assert.equal(gate.isHeld(), true);
	assert.deepEqual(sent, []);
});

test("a new compaction during drain stops before the next entry", () => {
	const scheduled: Array<() => void> = [];
	const delivered: string[] = [];
	let gate!: ReturnType<typeof createCompactionDeliveryGate>;
	gate = createCompactionDeliveryGate({
		maxEntries: 4,
		maxBytes: 100,
		schedule: (task) => scheduled.push(task),
		deliver: (entry) => {
			delivered.push(entry.id);
			if (entry.id === "first") gate.compactionStarted();
		},
	});
	const generation = gate.compactionStarted();
	gate.accept(envelope("first"));
	gate.accept(envelope("second"));
	gate.compactionEnded(generation);
	scheduled.shift()!();
	assert.deepEqual(delivered, ["first"]);
	assert.equal(gate.pendingCount(), 1);
});

test("a new compaction before the post-event task keeps the queue pending", () => {
	const { gate, scheduled, delivered } = setup();
	const generation = gate.compactionStarted();
	gate.accept(envelope("first"));
	gate.compactionEnded(generation);
	gate.compactionStarted();
	scheduled.shift()!();
	assert.deepEqual(delivered, []);
	assert.equal(gate.pendingCount(), 1);
});
