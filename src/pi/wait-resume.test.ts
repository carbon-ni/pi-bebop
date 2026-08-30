import test from "node:test";
import assert from "node:assert/strict";
import { YieldingWaitRegistry } from "../domain/index.ts";
import { YieldingWaitRuntime, WAIT_RESUME_MESSAGE_TYPE } from "./wait-resume.ts";

const deadline = 1_000 + 300_000;

function setup(runIdle = true) {
	const registry = new YieldingWaitRegistry();
	const delivered: Array<{ customType: string; content: string; deliverAs: string; details: unknown }> = [];
	const runtime = new YieldingWaitRuntime({
		registry,
		deliver: (message) => delivered.push(message),
		isRunIdle: () => runIdle,
		now: () => 1_000,
		createId: () => `wait-${delivered.length + registry.pendingCount() + 1}`,
	});
	return { registry, runtime, delivered };
}

test("TASK-0144: requester reminder is one nonterminal followUp/steer delivery", () => {
	const { runtime, delivered } = setup(false);
	runtime.deliverReminder({
		kind: "still-pending",
		requestId: "request-1",
		member: { name: "Kelly", role: "reviewer" },
		ageSeconds: 180,
	});
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]!.deliverAs, "followUp");
	assert.match(delivered[0]!.content, /request-1.*Kelly.*180s/);
	assert.deepEqual(delivered[0]!.details, {
		requestReminders: [
			{
				kind: "still-pending",
				requestId: "request-1",
				member: { name: "Kelly", role: "reviewer" },
				ageSeconds: 180,
			},
		],
	});
});

test("TASK-0144: parked requester wait resumes on one nonterminal reminder and preserves it", () => {
	const { runtime, delivered, registry } = setup(true);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", deadlineAt: deadline }).ok, true);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "still-pending",
			observedAt: 181_000,
			pending_count: 1,
			reminder: { member: { name: "Kelly", role: "reviewer" }, ageSeconds: 180 },
		}),
		true,
	);
	assert.equal(registry.pendingCount(), 0);
	assert.match(delivered[0]!.content, /still-pending/);
	assert.match(delivered[0]!.content, /Reminder: Kelly \(reviewer\)/);
	assert.deepEqual((delivered[0]!.details as { reminder?: unknown }).reminder, {
		member: { name: "Kelly", role: "reviewer" },
		ageSeconds: 180,
	});
});

test("TASK-0077: park + terminal resolves exactly once and delivers one steer resume when idle", () => {
	const { registry, runtime, delivered } = setup(true);
	const parked = runtime.park({ kind: "member-idle", target: "Kelly", deadlineAt: deadline });
	assert.equal(parked.ok, true);
	assert.equal(registry.pendingCount(), 1);

	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 2_000 }),
		true,
	);
	assert.equal(registry.pendingCount(), 0);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]!.customType, WAIT_RESUME_MESSAGE_TYPE);
	assert.equal(delivered[0]!.deliverAs, "steer");
	assert.match(delivered[0]!.content, /^\[wait resume\] member-idle Kelly: became-idle/);

	// Exactly once: a second terminal event emits nothing.
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 3_000 }),
		false,
	);
	assert.equal(delivered.length, 1);
});

test("TASK-0077: busy run buffers the resume one-shot as followUp, never lost", () => {
	const { runtime, delivered } = setup(false);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", deadlineAt: deadline }).ok, true);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 4_000,
			response: { message: "Kelly approved", instructions: ["attach report"] },
		}),
		true,
	);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]!.deliverAs, "followUp");
	assert.match(delivered[0]!.content, /request-outcome request-1: response/);
	assert.match(delivered[0]!.content, /Kelly approved/);
	assert.match(delivered[0]!.content, /attach report/);
});

test("TASK-0080-fix: a correlated Response carries its FULL message + ordered instructions into the resume content and details", () => {
	const { runtime, delivered } = setup(true);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", deadlineAt: deadline }).ok, true);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "response",
			observedAt: 4_000,
			response: { message: "QA verdict: PASS, evidence linked", instructions: ["attach report", "confirm gate"] },
		}),
		true,
	);
	assert.equal(delivered.length, 1);
	const details = delivered[0]!.details as { response?: { message: string; instructions: readonly string[] } };
	assert.equal(details.response?.message, "QA verdict: PASS, evidence linked");
	assert.deepEqual(details.response?.instructions, ["attach report", "confirm gate"]);
	// The requester resumes with the actual answer, never a bare outcome marker.
	assert.match(delivered[0]!.content, /request-outcome request-1: response/);
	assert.match(delivered[0]!.content, /Response: QA verdict: PASS, evidence linked/);
	assert.match(delivered[0]!.content, /1\. attach report/);
	assert.match(delivered[0]!.content, /2\. confirm gate/);
	// A response outcome WITHOUT the payload is malformed and must never resume.
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-2", deadlineAt: deadline }).ok, true);
	assert.equal(
		runtime.resolve({ kind: "request-outcome", target: "request-2", outcome: "response", observedAt: 5_000 }),
		false,
	);
	assert.equal(delivered.length, 1, "payload-less response must not consume the wait");
});

test("TASK-0077: cancel removes the parked wait and terminal never resumes", () => {
	const { registry, runtime, delivered } = setup(true);
	assert.equal(runtime.park({ kind: "member-idle", target: "Kelly", deadlineAt: deadline }).ok, true);
	const id = registry.pendingCount();
	assert.equal(runtime.cancel(`wait-${id}`), true);
	assert.equal(registry.pendingCount(), 0);
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 2_000 }),
		false,
	);
	assert.equal(delivered.length, 0);
});

test("TASK-0077 regression: malformed or unexpected terminals never consume a parked wait or resume", () => {
	const { registry, runtime, delivered } = setup(true);
	assert.equal(runtime.park({ kind: "member-idle", target: "Kelly", deadlineAt: deadline }).ok, true);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", deadlineAt: deadline }).ok, true);

	// Kelly's QA scenario: MALFORMED_UNEXPECTED outcome + observedAt NaN.
	assert.equal(
		runtime.resolve({
			kind: "member-idle",
			target: "Kelly",
			outcome: "MALFORMED_UNEXPECTED",
			observedAt: Number.NaN,
		}),
		false,
	);
	assert.equal(registry.pendingCount(), 2, "malformed delivery must leave both waits parked");
	assert.equal(delivered.length, 0, "never resume on a malformed delivery");

	// Unexpected transport outcome for the kind, empty target, non-finite time.
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Kelly", outcome: "transport-error", observedAt: 2_000 }),
		false,
	);
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "", outcome: "became-idle", observedAt: 2_000 }),
		false,
	);
	assert.equal(
		runtime.resolve({
			kind: "member-idle",
			target: "Kelly",
			outcome: "became-idle",
			observedAt: Number.POSITIVE_INFINITY,
		}),
		false,
	);
	assert.equal(
		runtime.resolve({ kind: "other", target: "Kelly", outcome: "became-idle", observedAt: 2_000 } as never),
		false,
	);
	assert.equal(registry.pendingCount(), 2);

	// A valid terminal still resolves exactly once afterwards.
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 3_000 }),
		true,
	);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "timeout:max-wait",
			observedAt: 4_000,
		}),
		true,
	);
	assert.equal(delivered.length, 2);
	// TASK-0080: a bare timeout (no reason) is now an unexpected terminal marker
	// and must never consume a parked wait.
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-2", deadlineAt: deadline }).ok, true);
	assert.equal(
		runtime.resolve({ kind: "request-outcome", target: "request-2", outcome: "timeout", observedAt: 5_000 }),
		false,
	);
	assert.equal(registry.pendingCount(), 1, "bare timeout must not consume the wait");
});

test("TASK-0077: request-outcome waits resolve FIFO while member-idle stays target-scoped", () => {
	const { runtime, delivered } = setup(true);
	assert.equal(runtime.park({ kind: "member-idle", target: "Kelly", deadlineAt: deadline }).ok, true);
	assert.equal(runtime.park({ kind: "member-idle", target: "Mary", deadlineAt: deadline }).ok, true);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-1", deadlineAt: deadline }).ok, true);
	assert.equal(runtime.park({ kind: "request-outcome", target: "request-2", deadlineAt: deadline }).ok, true);
	// Member-idle is target-scoped: Kelly's terminal resolves only Kelly's wait.
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 2_000 }),
		true,
	);
	assert.equal(delivered[0]!.content.includes("Kelly"), true);
	assert.equal(
		runtime.resolve({ kind: "member-idle", target: "Mary", outcome: "became-idle", observedAt: 3_000 }),
		true,
	);
	// Request-outcome is FIFO: request-2's terminal resolves the oldest parked wait.
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-2",
			outcome: "response",
			observedAt: 4_000,
			response: { message: "done", instructions: [] },
		}),
		true,
	);
	assert.equal(delivered[2]!.content.includes("request-2"), true);
	assert.match(delivered[2]!.content, /\nResponse: done/);
	assert.equal(
		runtime.resolve({
			kind: "request-outcome",
			target: "request-1",
			outcome: "timeout:response-after-idle",
			observedAt: 5_000,
		}),
		true,
	);
	assert.equal(delivered[3]!.content.includes("request-1"), true);
	assert.equal(delivered[3]!.content.includes("\nResponse:"), false, "non-response outcomes carry no payload");
	assert.equal(delivered.length, 4);
});
