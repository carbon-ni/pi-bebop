import test from "node:test";
import assert from "node:assert/strict";
import { YieldingWaitRegistry } from "../domain/index.ts";
import { YieldingWaitRuntime, WAIT_RESUME_MESSAGE_TYPE } from "./wait-resume.ts";

function setup() {
	const registry = new YieldingWaitRegistry();
	const delivered: Array<{ customType: string; content: string; deliverAs: string; details: unknown }> = [];
	const runtime = new YieldingWaitRuntime({
		registry,
		deliver: (message) => delivered.push(message),
		isRunIdle: () => true,
		now: () => 1_000,
		createId: () => `wait-${delivered.length + registry.pendingCount() + 1}`,
	});
	return { registry, runtime, delivered };
}

test("TASK-0151: semantic duplicate park returns the existing id without duplicate lifecycle state", () => {
	const { runtime, registry } = setup();
	const first = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const duplicate = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	assert.equal(duplicate.ok, true);
	if (duplicate.ok) assert.equal(duplicate.id, first.id);
	assert.equal(registry.pendingCount(), 1);
	assert.equal(runtime.queuedCount(), 0);
});

test("TASK-0151: terminal resolve queues one resume and internal lifecycle state clears on settle", () => {
	const { runtime, delivered } = setup();
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	if (!parked.ok) return;
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 2_000,
			response: { message: "Kelly approved", instructions: ["attach report"] },
		}),
		true,
	);
	assert.equal(delivered[0]!.customType, WAIT_RESUME_MESSAGE_TYPE);
	assert.equal((delivered[0]!.details as { waitId: string }).waitId, parked.id);
	assert.equal(runtime.queuedCount(), 1);
	runtime.markStarted();
	assert.equal(runtime.queuedCount(), 0);
	assert.equal(runtime.startedCount(), 1);
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
	// Unrelated settles do not mutate lifecycle state.
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
});

test("TASK-0151: cancellation prevents resume and releases parked and queued state", () => {
	const { runtime, delivered } = setup();
	const parked = runtime.park({ kind: "member-idle", target: "Kelly", sessionId: "s1" });
	if (!parked.ok) return;
	assert.equal(runtime.cancel(parked.id), true);
	assert.equal(delivered.length, 0);
	assert.equal(runtime.queuedCount(), 0);
	runtime.markStarted();
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
});

test("TASK-0151: malformed or foreign terminals never consume a parked wait", () => {
	const { runtime, registry } = setup();
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" }).ok, true);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "MALFORMED_UNEXPECTED",
			observedAt: Number.NaN,
		}),
		false,
	);
	assert.equal(
		runtime.resolve({ kind: "request-outcome", target: "request-1", outcome: "timeout", observedAt: 2_000 }),
		false,
	);
	assert.equal(registry.pendingCount(), 1);
	assert.equal(runtime.queuedCount(), 0);
});

test("TASK-0151: multiple terminal resumes share one outcome turn and settle once per wait", () => {
	const { runtime } = setup();
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" }).ok, true);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-2", sessionId: "s1" }).ok, true);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 2_000,
			response: { message: "Kelly approved", instructions: ["attach report"] },
		}),
		true,
	);
	assert.equal(
		runtime.resolve({ kind: "request-outcome", target: "request-2", outcome: "offline", observedAt: 2_100 }),
		true,
	);
	assert.equal(runtime.queuedCount(), 2);
	runtime.markStarted();
	assert.equal(runtime.startedCount(), 2);
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
});

test("TASK-0151: queued cancellation needs no outcome turn and started waits cannot be cancelled", () => {
	const { runtime } = setup();
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	if (!parked.ok) return;
	runtime.resolve({
		kind: "request-outcome",
		target: "request-1",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "Kelly approved", instructions: [] },
	});
	assert.equal(runtime.cancel(parked.id), true);
	assert.equal(runtime.queuedCount(), 0);
	runtime.markStarted();
	runtime.markSettled();
	const next = runtime.park({ kind: "request-outcome", target: "request-2", sessionId: "s1" });
	if (!next.ok) return;
	runtime.resolve({ kind: "request-outcome", target: "request-2", outcome: "offline", observedAt: 2_000 });
	runtime.markStarted();
	assert.equal(runtime.cancel(next.id), false);
	assert.equal(runtime.startedCount(), 1);
	runtime.markSettled();
});

test("TASK-0151: shutdown cancels every parked wait", () => {
	const { runtime, registry } = setup();
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" }).ok, true);
	assert.equal(runtime.park({ kind: "member-idle", target: "Kelly", sessionId: "s1" }).ok, true);
	const ids = runtime.cancelAll();
	assert.equal(ids.length, 2);
	assert.equal(registry.pendingCount(), 0);
	assert.equal(runtime.queuedCount(), 0);
	assert.equal(runtime.startedCount(), 0);
});
