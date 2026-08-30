import test from "node:test";
import assert from "node:assert/strict";
import { RequestReminderScheduler, REQUEST_REMINDER_DELAY_MS } from "./request-reminder.ts";

function fakeClock() {
	let now = 1_000_000;
	const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
	return {
		timers,
		now: () => now,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
		setTimeout: (callback: () => void, delay: number) => {
			const timer = { callback, delay, cancelled: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout: (handle: unknown) => {
			(handle as { cancelled: boolean }).cancelled = true;
		},
	};
}

test("request reminder fires once at exactly acceptedAt plus 180 seconds", () => {
	const clock = fakeClock();
	const reminders: unknown[] = [];
	const scheduler = new RequestReminderScheduler({ ...clock, onReminder: (reminder) => reminders.push(reminder) });
	scheduler.register("request-1", { name: "Dave", role: "developer" });
	assert.equal(clock.timers[0]?.delay, REQUEST_REMINDER_DELAY_MS);
	clock.advance(179_999);
	assert.deepEqual(reminders, []);
	clock.timers[0]!.callback();
	assert.deepEqual(reminders, []);
	clock.advance(1);
	clock.timers[1]!.callback();
	assert.deepEqual(reminders, [
		{ kind: "still-pending", requestId: "request-1", member: { name: "Dave", role: "developer" }, ageSeconds: 180 },
	]);
	clock.timers[0]!.callback();
	assert.equal(reminders.length, 1);
});

test("same-turn due reminders batch in acceptance order", () => {
	const clock = fakeClock();
	const batches: string[][] = [];
	const scheduler = new RequestReminderScheduler({
		...clock,
		onReminders: (reminders) => batches.push(reminders.map((reminder) => reminder.requestId)),
	});
	scheduler.register("request-a", { name: "Dave", role: "developer" });
	scheduler.register("request-b", { name: "Kelly", role: "reviewer" });
	clock.advance(REQUEST_REMINDER_DELAY_MS);
	clock.timers[0]!.callback();
	assert.deepEqual(batches, [["request-a", "request-b"]]);
});

test("terminal cancellation removes the exact reminder and emits nothing", () => {
	const clock = fakeClock();
	const reminders: unknown[] = [];
	const scheduler = new RequestReminderScheduler({ ...clock, onReminder: (reminder) => reminders.push(reminder) });
	scheduler.register("request-a", { name: "Dave", role: "developer" });
	scheduler.register("request-b", { name: "Kelly", role: "reviewer" });
	assert.equal(scheduler.cancel("request-a"), true);
	clock.advance(REQUEST_REMINDER_DELAY_MS);
	clock.timers[0]!.callback();
	clock.timers[1]!.callback();
	assert.deepEqual(reminders, [
		{ kind: "still-pending", requestId: "request-b", member: { name: "Kelly", role: "reviewer" }, ageSeconds: 180 },
	]);
});
