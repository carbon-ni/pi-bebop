import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRetrospectiveSchedule, completeRetrospectiveSchedule } from "./crew-retrospective-cadence.ts";
import { emptyRetrospectiveSchedule, type CrewMember, type RetrospectiveScheduleState } from "../domain/index.ts";

const day = 86_400_000;
const member = {
	name: "Dave",
	role: "dev",
	socket: "sockets/dave.sock",
	socketPath: "/repo/.pi/bebop/sockets/dave.sock",
} as const;
const mary = {
	name: "Mary",
	role: "po",
	socket: "sockets/mary.sock",
	socketPath: "/repo/.pi/bebop/sockets/mary.sock",
} as const;
function membership() {
	return {
		manifestPath: "/repo/.pi/bebop/crew.json",
		member,
		manifest: {
			members: [member, mary],
			crewAgreements: { retrospective: { facilitator: "Mary", cadenceDays: 1 } },
		},
	};
}
function harness(initial: RetrospectiveScheduleState | null = null) {
	let state = initial;
	const persisted: RetrospectiveScheduleState[] = [];
	const reminders: { target: string; id: string }[] = [];
	return {
		persisted,
		reminders,
		deps: (now: number, openRound = false) => ({
			readState: async () => state,
			persistState: async (next: RetrospectiveScheduleState) => {
				state = next;
				persisted.push(next);
			},
			enqueueReminder: async (target: CrewMember, _payload: unknown, id: string) => {
				const existing = reminders.find((item) => item.id === id);
				if (existing) return "already-persisted" as const;
				reminders.push({ target: target.name, id });
				return "persisted" as const;
			},
			now: () => now,
			openRound: async () => openRound,
		}),
		getState: () => state,
	};
}

test("first check persists configuredAt; due check persists marker before exactly one reminder", async () => {
	const h = harness();
	const first = await checkRetrospectiveSchedule(membership(), h.deps(1));
	assert.equal(first.schedule.status, "not-due");
	assert.equal(h.persisted.length, 1);
	const due = await checkRetrospectiveSchedule(membership(), h.deps(day + 1));
	assert.equal(due.reminder, "persisted");
	assert.equal(h.persisted.length, 2);
	assert.deepEqual(
		h.reminders.map((item) => item.target),
		["Mary"],
	);
	const retry = await checkRetrospectiveSchedule(membership(), h.deps(0));
	assert.equal(retry.reminder, "already-persisted");
	assert.equal(h.persisted.length, 2);
	assert.equal(h.reminders.length, 1, "stable Inbox idempotency prevents duplicate durable reminders");
	assert.equal(retry.reminder, "already-persisted");
});

test("open round suppresses due marker and no facilitator fallback is selected", async () => {
	const h = harness();
	const result = await checkRetrospectiveSchedule(membership(), h.deps(day + 1, true));
	assert.equal(result.schedule.status, "open");
	assert.equal(result.reminder, "not-needed");
	assert.deepEqual(h.reminders, []);
	const unavailable = await checkRetrospectiveSchedule(
		{
			...membership(),
			manifest: { members: [member], crewAgreements: { retrospective: { facilitator: "Mary", cadenceDays: 1 } } },
		},
		h.deps(2 * day + 1),
	);
	assert.equal(unavailable.schedule.facilitator, "unavailable");
	assert.equal(unavailable.reminder, "unavailable");
});

test("Inbox failure leaves due marker durable for later retry and completion is explicit", async () => {
	const h = harness();
	await checkRetrospectiveSchedule(membership(), h.deps(1));
	const failing = {
		...h.deps(day + 1),
		enqueueReminder: async () => {
			throw new Error("offline");
		},
	};
	const result = await checkRetrospectiveSchedule(membership(), failing);
	assert.equal(result.schedule.status, "due");
	assert.equal(result.reminder, "failed");
	const completed = await completeRetrospectiveSchedule(
		{ readState: h.deps(day + 1).readState, persistState: h.deps(day + 1).persistState },
		day + 2,
	);
	assert.equal(completed.latestCompletedAt, day + 2);
	assert.equal(completed.dueMarker, undefined);
});
