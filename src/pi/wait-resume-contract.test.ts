import test from "node:test";
import assert from "node:assert/strict";
import { YieldingWaitRegistry } from "../domain/index.ts";
import {
	YieldingWaitRuntime,
	WAIT_PARKED,
	WAIT_RESUME_QUEUED,
	WAIT_RESUME_STARTED,
	WAIT_RESUME_SETTLED,
	WAIT_CANCELLED,
	type WaitEvent,
} from "./wait-resume.ts";

const deadline = 1_000 + 300_000;

function setup() {
	const registry = new YieldingWaitRegistry();
	const delivered: Array<{ customType: string; content: string; deliverAs: string; details: unknown }> = [];
	const events: WaitEvent[] = [];
	const runtime = new YieldingWaitRuntime({
		registry,
		deliver: (message) => delivered.push(message),
		isRunIdle: () => true,
		publish: (event) => events.push(event),
		now: () => 1_000,
		createId: () => `wait-${events.length + delivered.length + registry.pendingCount() + 1}`,
	});
	return { registry, runtime, delivered, events };
}

test("TASK-0080 D1: first park publishes wait-parked once; a semantic duplicate park returns the existing id and publishes nothing", () => {
	const { runtime, events } = setup();
	const first = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.deepEqual(events, [{ type: WAIT_PARKED, waitId: first.id, kind: "request-outcome" }]);
	// Duplicate (same session+kind+target): existing id, no new event.
	const duplicate = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	assert.equal(duplicate.ok, true);
	if (duplicate.ok) assert.equal(duplicate.id, first.id);
	assert.equal(events.length, 1, "duplicate park publishes no new shared event");
});

test("TASK-0080 D2: resolve queues the resume (wait-resume-queued + details.waitId), started at run start, settled at that run's settle", () => {
	const { runtime, delivered, events } = setup();
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	if (!parked.ok) return;
	const resolved = runtime.resolve({
		kind: "request-outcome",
		target: "request-1",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "Kelly approved", instructions: ["attach report"] },
	});
	assert.equal(resolved, true);
	assert.equal(events[events.length - 1]!.type, WAIT_RESUME_QUEUED);
	assert.equal((delivered[0]!.details as { waitId: string }).waitId, parked.id);
	assert.equal(runtime.queuedCount(), 1);
	// Run starts: resume entered context -> started (bound), queued empty.
	runtime.markStarted();
	assert.equal(runtime.queuedCount(), 0);
	assert.equal(runtime.startedCount(), 1);
	assert.equal(events[events.length - 1]!.type, WAIT_RESUME_STARTED);
	assert.equal(events[events.length - 1]!.waitId, parked.id);
	// That run settles -> settled exactly once.
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
	assert.equal(events[events.length - 1]!.type, WAIT_RESUME_SETTLED);
	assert.equal(events[events.length - 1]!.waitId, parked.id);
	// Unrelated settles publish nothing.
	const count = events.length;
	runtime.markSettled();
	assert.equal(events.length, count);
});

test("TASK-0080 D3: cancel publishes wait-cancelled, queues no resume, and never settles", () => {
	const { runtime, delivered, events } = setup();
	const parked = runtime.park({ kind: "member-idle", target: "Kelly", sessionId: "s1" });
	if (!parked.ok) return;
	assert.equal(runtime.cancel(parked.id), true);
	assert.equal(events[events.length - 1]!.type, WAIT_CANCELLED);
	assert.equal(events[events.length - 1]!.waitId, parked.id);
	assert.equal(delivered.length, 0, "cancel queues no resume");
	runtime.markStarted();
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
	const settled = events.filter((event) => event.type === WAIT_RESUME_SETTLED);
	assert.equal(settled.length, 0, "cancelled wait never settles");
});

test("TASK-0080 D4: malformed/foreign terminals never consume a parked wait and publish nothing", () => {
	const { runtime, events } = setup();
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	if (!parked.ok) return;
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
	assert.equal(runtime.queuedCount(), 0);
	assert.equal(events.filter((event) => event.type === WAIT_RESUME_QUEUED).length, 0);
});

test("TASK-0080 D5: multi-resume-one-turn emits started and settled once per waitId", () => {
	const { runtime, events } = setup();
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
	runtime.markStarted(); // both resumes enter the same outcome turn
	const started = events.filter((event) => event.type === WAIT_RESUME_STARTED);
	assert.equal(started.length, 2);
	runtime.markSettled(); // that turn settles
	const settled = events.filter((event) => event.type === WAIT_RESUME_SETTLED);
	assert.equal(settled.length, 2);
});

test("TASK-0080 D6: zero listeners is a no-op - the runtime works identically without a publisher", () => {
	const registry = new YieldingWaitRegistry();
	const delivered: Array<{ customType: string; content: string; deliverAs: string }> = [];
	const runtime = new YieldingWaitRuntime({
		registry,
		deliver: (message) => delivered.push(message),
		isRunIdle: () => true,
		now: () => 1_000,
		createId: () => "wait-z",
	});
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	assert.equal(parked.ok, true);
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
	assert.equal(delivered.length, 1);
	runtime.markStarted();
	runtime.markSettled();
	assert.equal(runtime.startedCount(), 0);
});

/** TASK-0080 G7/G8/G9: simulate the pi-auto loop's two disjoint sets
 * (live = parked|queued, outcome-pending = started) purely from the published
 * events, mirroring the approved Bebop<->auto handshake. */
class AutoLoopStub {
	live = new Set<string>();
	outcomePending = new Set<string>();
	unpauseCount = 0;
	constructor(events: WaitEvent[]) {
		for (const event of events) {
			if (event.type === WAIT_PARKED) this.live.add(event.waitId);
			else if (event.type === WAIT_RESUME_QUEUED) this.live.add(event.waitId);
			else if (event.type === WAIT_RESUME_STARTED) {
				this.live.delete(event.waitId);
				this.outcomePending.add(event.waitId);
			} else if (event.type === WAIT_RESUME_SETTLED) {
				if (this.outcomePending.delete(event.waitId)) this.unpauseCount += 1;
			} else if (event.type === WAIT_CANCELLED) {
				this.live.delete(event.waitId);
				this.outcomePending.delete(event.waitId);
			}
		}
	}
	hasLive(): boolean {
		return this.live.size > 0 || this.outcomePending.size > 0;
	}
}

test("TASK-0080 G7: auto-style handshake pauses through queued and unrelated turns and unpauses only after the matching outcome turn settles", () => {
	const { runtime, events } = setup();
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	if (!parked.ok) return;
	runtime.resolve({
		kind: "request-outcome",
		target: "request-1",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "Kelly approved", instructions: ["attach report"] },
	});
	// An unrelated settle while the resume is only queued publishes nothing.
	runtime.markSettled();
	let auto = new AutoLoopStub(events);
	assert.equal(auto.hasLive(), true, "loop stays paused while resume is queued");
	// The outcome turn starts: live -> outcome-pending.
	runtime.markStarted();
	auto = new AutoLoopStub(events);
	assert.equal(auto.live.has(parked.id), false);
	assert.equal(auto.outcomePending.has(parked.id), true);
	assert.equal(auto.hasLive(), true, "still paused through the outcome turn");
	// The exact outcome turn settles: unpause exactly one iteration.
	runtime.markSettled();
	auto = new AutoLoopStub(events);
	assert.equal(auto.hasLive(), false);
	assert.equal(auto.unpauseCount, 1);
	// Later unrelated settles do not unpause again.
	runtime.markSettled();
	auto = new AutoLoopStub(events);
	assert.equal(auto.unpauseCount, 1);
});

test("TASK-0080 G8: multiple wait ids stay paused until all matching settled/cancelled events remove them", () => {
	const { runtime, events } = setup();
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
	runtime.markStarted();
	runtime.markSettled(); // both entered and settled in one outcome turn
	let auto = new AutoLoopStub(events);
	assert.equal(auto.hasLive(), false, "both removed by the matching settle");
	// One id cancelled from resume-queued, the other settled: the loop stays
	// paused until BOTH removals happen (cancel needs no settle).
	const { runtime: r2, events: e2 } = setup();
	const a = r2.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	const b = r2.park({ kind: "request-outcome", target: "request-2", sessionId: "s1" });
	if (!a.ok || !b.ok) return;
	r2.resolve({
		kind: "request-outcome",
		target: "request-1",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "Kelly approved", instructions: ["attach report"] },
	});
	r2.resolve({ kind: "request-outcome", target: "request-2", outcome: "offline", observedAt: 2_100 });
	assert.equal(r2.cancel(b.id), true, "cancel valid from resume-queued");
	r2.markStarted(); // only request-1's resume enters the outcome turn
	auto = new AutoLoopStub(e2);
	assert.equal(auto.outcomePending.has(a.id), true);
	assert.equal(auto.live.has(b.id), false, "cancelled id removed immediately by its cancel");
	assert.equal(auto.hasLive(), true, "still paused while request-1's outcome turn runs");
	r2.markSettled(); // request-1's turn settles
	auto = new AutoLoopStub(e2);
	assert.equal(auto.hasLive(), false, "both removals happened: settle for a, cancel for b");
	// Cancel from resume-started is impossible (request already terminated).
	const { runtime: r3 } = setup();
	const c = r3.park({ kind: "request-outcome", target: "request-3", sessionId: "s1" });
	if (!c.ok) return;
	r3.resolve({
		kind: "request-outcome",
		target: "request-3",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "Kelly approved", instructions: ["attach report"] },
	});
	r3.markStarted();
	assert.equal(r3.cancel(c.id), false, "cancel from resume-started is impossible");
});

test("TASK-0080 G9: cancel from resume-queued needs no outcome turn - auto continues as soon as no live/outcome-pending id remains", () => {
	const { runtime, events } = setup();
	const parked = runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" });
	if (!parked.ok) return;
	runtime.resolve({
		kind: "request-outcome",
		target: "request-1",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "Kelly approved", instructions: ["attach report"] },
	});
	assert.equal(runtime.queuedCount(), 1);
	assert.equal(runtime.cancel(parked.id), true, "cancel valid from resume-queued");
	assert.equal(runtime.queuedCount(), 0);
	const auto = new AutoLoopStub(events);
	assert.equal(auto.live.has(parked.id), false);
	assert.equal(auto.outcomePending.has(parked.id), false);
	assert.equal(auto.hasLive(), false, "cancel removes from both sets immediately: no settle required");
	// The cancelled resume never becomes an outcome turn: later starts/settles
	// publish nothing for it.
	runtime.markStarted();
	runtime.markSettled();
	assert.equal(events.filter((event) => event.type === WAIT_RESUME_STARTED).length, 0);
});

test("TASK-0080 G12: shutdown cancelAll publishes wait-cancelled per id and leaves no parked/queued/started wait", () => {
	const { runtime, events } = setup();
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", sessionId: "s1" }).ok, true);
	assert.equal(runtime.park({ kind: "member-idle", target: "Kelly", sessionId: "s1" }).ok, true);
	const ids = runtime.cancelAll();
	assert.equal(ids.length, 2);
	const cancelled = events.filter((event) => event.type === WAIT_CANCELLED);
	assert.equal(cancelled.length, 2);
	assert.equal(runtime.queuedCount(), 0);
	assert.equal(runtime.startedCount(), 0);
	const auto = new AutoLoopStub(events);
	assert.equal(auto.hasLive(), false);
});
