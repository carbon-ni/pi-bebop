import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AcceptedLocalMessageWakeGate } from "./accepted-local-message-wake-gate.ts";

describe("AcceptedLocalMessageWakeGate (TASK-0081)", () => {
	test("arm registers a listener; notifyAccepted claims it once with the deliveryId", () => {
		const gate = new AcceptedLocalMessageWakeGate();
		const claimed: string[] = [];
		assert.deepEqual(
			gate.arm((deliveryId) => claimed.push(deliveryId)),
			{ ok: true },
		);
		assert.equal(gate.notifyAccepted("delivery-1"), true, "first accepted message claims the listener");
		assert.deepEqual(claimed, ["delivery-1"]);
		// The listener is consumed: a second accepted message has no listener.
		assert.equal(gate.notifyAccepted("delivery-2"), false);
		assert.deepEqual(claimed, ["delivery-1"]);
	});

	test("at most one armed listener: a second arm fails with wait-in-progress", () => {
		const gate = new AcceptedLocalMessageWakeGate();
		assert.deepEqual(
			gate.arm(() => undefined),
			{ ok: true },
		);
		assert.deepEqual(
			gate.arm(() => undefined),
			{ ok: false, code: "wait-in-progress" },
		);
	});

	test("release removes a listener without claiming it", () => {
		const gate = new AcceptedLocalMessageWakeGate();
		let claimed = 0;
		const listener = () => {
			claimed += 1;
		};
		assert.deepEqual(gate.arm(listener), { ok: true });
		gate.release(listener);
		assert.equal(gate.notifyAccepted("delivery-1"), false);
		assert.equal(claimed, 0);
		// After release the slot is free for a new wait.
		assert.deepEqual(
			gate.arm(() => undefined),
			{ ok: true },
		);
	});

	test("a message accepted before arm does not wake the later wait (no-lost-wake starts at arm)", () => {
		const gate = new AcceptedLocalMessageWakeGate();
		assert.equal(gate.notifyAccepted("delivery-0"), false, "no listener armed yet");
		const claimed: string[] = [];
		assert.deepEqual(
			gate.arm((deliveryId) => claimed.push(deliveryId)),
			{ ok: true },
		);
		assert.equal(gate.notifyAccepted("delivery-1"), true);
		assert.deepEqual(claimed, ["delivery-1"], "pre-arm acceptance never wakes the armed listener");
	});

	test("arm after a claimed release is free; gate holds no content, routes, or state", () => {
		const gate = new AcceptedLocalMessageWakeGate();
		const listener = () => undefined;
		assert.deepEqual(gate.arm(listener), { ok: true });
		gate.release(listener);
		assert.deepEqual(gate.arm(listener), { ok: true });
		gate.release(listener);
		// No lingering listener after claim/release cycles.
		assert.equal(gate.notifyAccepted("delivery-x"), false);
	});
});
