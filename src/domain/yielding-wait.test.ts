import test from "node:test";
import assert from "node:assert/strict";
import { YieldingWaitRegistry, MAX_YIELDING_WAITS, validateYieldingWaitTerminal } from "./yielding-wait.ts";

const now = 1_000;
const deadline = now + 300_000;

test("TASK-0077 regression: malformed terminal payloads are rejected before any consume", () => {
	const validIdle = validateYieldingWaitTerminal({
		kind: "member-idle",
		target: "Kelly",
		outcome: "became-idle",
		observedAt: 2_000,
	});
	assert.equal(validIdle.ok, true);
	const validRequest = validateYieldingWaitTerminal({
		kind: "request-outcome",
		target: "request-1",
		outcome: "timeout:response-after-idle",
		observedAt: 2_000,
	});
	assert.equal(validRequest.ok, true);
	// TASK-0080: idle-without-response is removed from the public union.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome: "idle-without-response",
			observedAt: 2_000,
		}),
		{ ok: false, code: "invalid-outcome" },
	);

	// Kelly's QA scenario: unexpected outcome marker + non-finite timestamp.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "member-idle",
			target: "Kelly",
			outcome: "MALFORMED_UNEXPECTED",
			observedAt: Number.NaN,
		}),
		{ ok: false, code: "invalid-outcome" },
	);
	// Unknown kind, empty target, unexpected outcome for the kind, non-finite timestamp.
	assert.deepEqual(
		validateYieldingWaitTerminal({ kind: "other", target: "Kelly", outcome: "became-idle", observedAt: 2_000 }),
		{
			ok: false,
			code: "invalid-kind",
		},
	);
	assert.deepEqual(validateYieldingWaitTerminal(null), { ok: false, code: "invalid-kind" });
	assert.deepEqual(
		validateYieldingWaitTerminal({ kind: "member-idle", target: "", outcome: "became-idle", observedAt: 2_000 }),
		{ ok: false, code: "invalid-target" },
	);
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "member-idle",
			target: "Kelly",
			outcome: "transport-error",
			observedAt: 2_000,
		}),
		{ ok: false, code: "invalid-outcome" },
	);
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "r1",
			outcome: "became-idle",
			observedAt: 2_000,
		}),
		{ ok: false, code: "invalid-outcome" },
	);
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "member-idle",
			target: "Kelly",
			outcome: "became-idle",
			observedAt: Number.POSITIVE_INFINITY,
		}),
		{ ok: false, code: "invalid-observed-at" },
	);
	assert.deepEqual(
		validateYieldingWaitTerminal({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: "2" }),
		{ ok: false, code: "invalid-observed-at" },
	);
});

test("TASK-0077: registers one-shot pending waits and resolves exactly once in registration order", () => {
	const registry = new YieldingWaitRegistry();
	assert.equal(
		registry.register({
			id: "w-kelly",
			kind: "member-idle",
			target: "Kelly",
			deadlineAt: deadline,
			sessionId: "s1",
		}).ok,
		true,
	);
	assert.equal(
		registry.register({
			id: "w-req-1",
			kind: "request-outcome",
			target: "request-1",
			deadlineAt: deadline,
			sessionId: "s1",
		}).ok,
		true,
	);
	assert.equal(
		registry.register({
			id: "w-req-2",
			kind: "request-outcome",
			target: "request-2",
			deadlineAt: deadline,
			sessionId: "s1",
		}).ok,
		true,
	);
	assert.equal(registry.pendingCount(), 3);

	// Oldest matching wait resolves first per kind+target.
	const first = registry.resolveFirst({
		kind: "member-idle",
		target: "Kelly",
		outcome: "became-idle",
		observedAt: 2_000,
	});
	assert.equal(first.ok, true);
	if (first.ok) assert.equal(first.value.id, "w-kelly");
	assert.equal(registry.pendingCount(), 2);

	// Exactly once: a second terminal event for the same target is a no-op.
	assert.deepEqual(
		registry.resolveFirst({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 3_000 }),
		{
			ok: false,
			code: "no-pending-wait",
		},
	);

	// Request-outcome waits are FIFO: the oldest terminal outcome resolves the
	// oldest parked wait, whichever request it belongs to.
	const second = registry.resolveFirst({
		kind: "request-outcome",
		target: "request-2",
		outcome: "response",
		observedAt: 4_000,
	});
	assert.equal(second.ok, true);
	if (second.ok) assert.equal(second.value.id, "w-req-1", "oldest request-outcome wait resolves first");
	const third = registry.resolveFirst({
		kind: "request-outcome",
		target: "request-1",
		outcome: "timeout:max-wait",
		observedAt: 5_000,
	});
	assert.equal(third.ok, true);
	if (third.ok) assert.equal(third.value.id, "w-req-2");
	assert.equal(registry.pendingCount(), 0);
});

test("TASK-0077: cancel removes a pending wait without emitting; unknown cancel is safe", () => {
	const registry = new YieldingWaitRegistry();
	assert.equal(
		registry.register({ id: "w-1", kind: "member-idle", target: "Kelly", deadlineAt: deadline, sessionId: "s1" })
			.ok,
		true,
	);
	assert.equal(registry.cancel("w-1"), true);
	assert.equal(registry.pendingCount(), 0);
	assert.equal(registry.cancel("w-1"), false);
	assert.equal(registry.cancel("missing"), false);
	assert.deepEqual(
		registry.resolveFirst({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 2_000 }),
		{
			ok: false,
			code: "no-pending-wait",
		},
	);
});

test("TASK-0080: same-identity park is idempotent; same id with a different identity is duplicate-wait; capacity is enforced", () => {
	const registry = new YieldingWaitRegistry();
	assert.equal(
		registry.register({ id: "w-1", kind: "member-idle", target: "Kelly", deadlineAt: deadline, sessionId: "s1" })
			.ok,
		true,
	);
	// TASK-0080: a semantic duplicate (same session+kind+target) returns the
	// EXISTING wait and opens no second entry.
	const duplicate = registry.register({
		id: "w-1",
		kind: "member-idle",
		target: "Kelly",
		deadlineAt: deadline,
		sessionId: "s1",
	});
	assert.equal(duplicate.ok, true);
	if (duplicate.ok) assert.equal(duplicate.value.id, "w-1");
	assert.equal(registry.pendingCount(), 1);
	// The same id with a DIFFERENT identity is still a duplicate-wait error.
	assert.deepEqual(
		registry.register({ id: "w-1", kind: "member-idle", target: "Other", deadlineAt: deadline, sessionId: "s1" }),
		{ ok: false, code: "duplicate-wait" },
	);
	const full = new YieldingWaitRegistry();
	for (let index = 0; index < MAX_YIELDING_WAITS; index += 1)
		assert.equal(
			full.register({
				id: `full-${index}`,
				kind: "member-idle",
				target: `member-${index}`,
				deadlineAt: deadline,
				sessionId: "s1",
			}).ok,
			true,
		);
	assert.deepEqual(
		full.register({ id: "overflow", kind: "member-idle", target: "X", deadlineAt: deadline, sessionId: "s1" }),
		{ ok: false, code: "capacity" },
	);
	assert.deepEqual(
		registry.register({ id: "", kind: "member-idle", target: "X", deadlineAt: deadline, sessionId: "s1" }),
		{ ok: false, code: "invalid-wait" },
	);
});
