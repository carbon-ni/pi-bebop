import assert from "node:assert/strict";
import test from "node:test";
import { YieldingWaitRegistry, MAX_YIELDING_WAITS, validateYieldingWaitTerminal } from "./yielding-wait.ts";

const now = 1_000;
const deadline = now + 300_000;

test("TASK-0080 B1: request-outcome terminal union drops idle-without-response and carries timeout reasons", () => {
	const idle = validateYieldingWaitTerminal({
		kind: "request-outcome",
		target: "request-1",
		outcome: "idle-without-response",
		observedAt: 2_000,
	});
	assert.deepEqual(idle, { ok: false, code: "invalid-outcome" });

	for (const outcome of ["response", "offline", "timeout:max-wait", "timeout:response-after-idle"]) {
		const valid = validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome,
			observedAt: 2_000,
			...(outcome === "response"
				? { response: { message: "Kelly approved", instructions: ["attach report"] } }
				: {}),
		});
		assert.equal(valid.ok, true, `expected ${outcome} to be accepted`);
	}
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome: "timeout",
			observedAt: 2_000,
		}),
		{ ok: false, code: "invalid-outcome" },
	);
});

test("TASK-0080-fix B3: the correlated Response payload is required for the response outcome and exclusive to it", () => {
	// A response outcome without the payload is malformed.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 2_000,
		}),
		{ ok: false, code: "invalid-response" },
	);
	// An empty message is invalid.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 2_000,
			response: { message: "  ", instructions: [] },
		}),
		{ ok: false, code: "invalid-response" },
	);
	// Non-string / non-array instructions are invalid.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 2_000,
			response: { message: "ok", instructions: "nope" },
		} as never),
		{ ok: false, code: "invalid-response" },
	);
	// A payload on a NON-response outcome is invalid.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "request-outcome",
			target: "request-1",
			outcome: "offline",
			observedAt: 2_000,
			response: { message: "ok", instructions: [] },
		} as never),
		{ ok: false, code: "invalid-response" },
	);
	// A payload on a member-idle terminal is invalid.
	assert.deepEqual(
		validateYieldingWaitTerminal({
			kind: "member-idle",
			target: "Kelly",
			outcome: "became-idle",
			observedAt: 2_000,
			response: { message: "ok", instructions: [] },
		} as never),
		{ ok: false, code: "invalid-response" },
	);
	// The valid response payload passes with the message and ordered instructions.
	const valid = validateYieldingWaitTerminal({
		kind: "request-outcome",
		target: "request-1",
		outcome: "response",
		observedAt: 2_000,
		response: { message: "QA verdict: PASS", instructions: ["attach report", "confirm gate"] },
	});
	assert.equal(valid.ok, true);
	if (valid.ok) assert.deepEqual(valid.value.response?.instructions, ["attach report", "confirm gate"]);
});

test("TASK-0080 B2: semantic duplicate park (same session+kind+target) returns the EXISTING wait id", () => {
	const registry = new YieldingWaitRegistry();
	const first = registry.register({
		id: "wait-1",
		kind: "request-outcome",
		target: "request-1",
		deadlineAt: deadline,
		sessionId: "session-a",
	});
	assert.equal(first.ok, true);
	if (!first.ok) return;
	// Same identity, different id -> idempotent: existing wait returned, no second entry.
	const duplicate = registry.register({
		id: "wait-2",
		kind: "request-outcome",
		target: "request-1",
		deadlineAt: deadline,
		sessionId: "session-a",
	});
	assert.equal(duplicate.ok, true);
	if (duplicate.ok) assert.equal(duplicate.value.id, "wait-1");
	assert.equal(registry.pendingCount(), 1);
});

test("TASK-0080 B3: different identity (target or session or kind) is a distinct wait", () => {
	const registry = new YieldingWaitRegistry();
	assert.equal(
		registry.register({
			id: "a",
			kind: "request-outcome",
			target: "request-1",
			deadlineAt: deadline,
			sessionId: "s",
		}).ok,
		true,
	);
	// Different target -> new wait.
	assert.equal(
		registry.register({
			id: "b",
			kind: "request-outcome",
			target: "request-2",
			deadlineAt: deadline,
			sessionId: "s",
		}).ok,
		true,
	);
	// Different session -> new wait.
	assert.equal(
		registry.register({
			id: "c",
			kind: "request-outcome",
			target: "request-1",
			deadlineAt: deadline,
			sessionId: "other",
		}).ok,
		true,
	);
	// Different kind -> new wait.
	assert.equal(
		registry.register({ id: "d", kind: "member-idle", target: "request-1", deadlineAt: deadline, sessionId: "s" })
			.ok,
		true,
	);
	assert.equal(registry.pendingCount(), 4);
});

test("TASK-0080 B4: cancel then re-park creates a NEW wait id (no idempotent reuse after cancel)", () => {
	const registry = new YieldingWaitRegistry();
	assert.equal(
		registry.register({
			id: "w1",
			kind: "request-outcome",
			target: "request-1",
			deadlineAt: deadline,
			sessionId: "s",
		}).ok,
		true,
	);
	assert.equal(registry.cancel("w1"), true);
	const repark = registry.register({
		id: "w2",
		kind: "request-outcome",
		target: "request-1",
		deadlineAt: deadline,
		sessionId: "s",
	});
	assert.equal(repark.ok, true);
	if (repark.ok) assert.equal(repark.value.id, "w2");
	assert.equal(registry.pendingCount(), 1);
});

test("TASK-0080 B5: capacity 16 is enforced on unique identities", () => {
	const registry = new YieldingWaitRegistry();
	for (let index = 0; index < MAX_YIELDING_WAITS; index += 1)
		assert.equal(
			registry.register({
				id: `w-${index}`,
				kind: "request-outcome",
				target: `request-${index}`,
				deadlineAt: deadline,
				sessionId: "s",
			}).ok,
			true,
		);
	assert.deepEqual(
		registry.register({
			id: "overflow",
			kind: "request-outcome",
			target: "request-overflow",
			deadlineAt: deadline,
			sessionId: "s",
		}),
		{ ok: false, code: "capacity" },
	);
	// A duplicate of a parked identity does NOT consume capacity.
	const dup = registry.register({
		id: "dup",
		kind: "request-outcome",
		target: "request-0",
		deadlineAt: deadline,
		sessionId: "s",
	});
	assert.equal(dup.ok, true);
	if (dup.ok) assert.equal(dup.value.id, "w-0");
});
