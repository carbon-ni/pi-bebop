import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildRetrospectiveDueReminder,
	deriveRetrospectiveSchedule,
	emptyRetrospectiveSchedule,
	recordRetrospectiveCompletion,
	validateRetrospectiveScheduleState,
} from "./index.ts";

const config = { facilitator: "Mary", cadenceDays: 1 } as const;
const day = 86_400_000;

test("cadence is not due before the exact boundary and is due at equality", () => {
	const state = emptyRetrospectiveSchedule();
	const before = deriveRetrospectiveSchedule({
		config,
		state,
		now: 1_000,
		openRound: false,
		facilitatorExists: true,
	});
	assert.equal(before.status, "not-due");
	assert.equal(before.state.configuredAt, 1_000);
	const at = deriveRetrospectiveSchedule({
		config,
		state: before.state,
		now: 1_000 + day,
		openRound: false,
		facilitatorExists: true,
	});
	assert.equal(at.status, "due");
	assert.equal(at.markerCreated, true);
	assert.equal(at.state.dueMarker?.anchor, 1_000);
});

test("marker freezes facilitator/cadence across edits and survives clock rollback", () => {
	const first = deriveRetrospectiveSchedule({
		config,
		state: emptyRetrospectiveSchedule(),
		now: 10,
		openRound: false,
		facilitatorExists: true,
	});
	const due = deriveRetrospectiveSchedule({
		config,
		state: first.state,
		now: day + 10,
		openRound: false,
		facilitatorExists: true,
	});
	const rollback = deriveRetrospectiveSchedule({
		config: { facilitator: "Dave", cadenceDays: 365 },
		state: due.state,
		now: 0,
		openRound: false,
		facilitatorExists: false,
	});
	assert.equal(rollback.status, "due");
	assert.equal(rollback.facilitator, "unavailable");
	assert.deepEqual(rollback.state.dueMarker, due.state.dueMarker);
});

test("open round wins over cadence and missing cadence is manual-only", () => {
	const due = deriveRetrospectiveSchedule({
		config,
		state: emptyRetrospectiveSchedule(),
		now: day,
		openRound: true,
		facilitatorExists: true,
	});
	assert.equal(due.status, "open");
	assert.equal(due.markerCreated, false);
	const manual = deriveRetrospectiveSchedule({
		config: { facilitator: "Mary" },
		state: emptyRetrospectiveSchedule(),
		now: day,
		openRound: false,
		facilitatorExists: true,
	});
	assert.equal(manual.status, "manual-only");
});

test("completion advances the anchor and removes the due marker", () => {
	const due = deriveRetrospectiveSchedule({
		config,
		state: emptyRetrospectiveSchedule(),
		now: day,
		openRound: false,
		facilitatorExists: true,
	});
	const completed = recordRetrospectiveCompletion(due.state, day + 5);
	assert.equal(completed.latestCompletedAt, day + 5);
	assert.equal("dueMarker" in completed, false);
	assert.throws(() => recordRetrospectiveCompletion(completed, day), /backward/);
});

test("state validation rejects forged marker identity and unsupported fields", () => {
	assert.throws(
		() => validateRetrospectiveScheduleState({ version: 1, kind: "crew-retrospective-schedule", extra: true }),
		/unsupported retrospective schedule field/,
	);
	assert.throws(
		() =>
			validateRetrospectiveScheduleState({
				version: 1,
				kind: "crew-retrospective-schedule",
				dueMarker: {
					id: "retro-due-00000000000000000000000000000000",
					anchor: 0,
					dueAt: day,
					cadenceDays: 1,
					facilitator: "Mary",
				},
			}),
		/identity mismatch/,
	);
});

test("reminder is bounded recovery guidance and never claims an action", () => {
	const schedule = deriveRetrospectiveSchedule({
		config,
		state: { ...emptyRetrospectiveSchedule(), configuredAt: 1 },
		now: day + 1,
		openRound: false,
		facilitatorExists: true,
	});
	const reminder = buildRetrospectiveDueReminder(schedule.state.dueMarker!);
	assert.match(reminder.message, /No round was started/);
	assert.match(reminder.message, /separate trusted Agreement activation/);
	assert.doesNotMatch(reminder.message, /request|redirect|interrupt/i);
});
