import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceLifecycleCoordinator, type PresenceMembership } from "./presence-lifecycle.ts";
import type { PresenceObserver } from "./presence-observer.ts";
import type { PresenceMember } from "../domain/index.ts";

const a: PresenceMember = { identity: "/a", name: "a", role: "dev" };
const b: PresenceMember = { identity: "/b", name: "b", role: "qa" };
function fake(log: string[], failStart = false, failBroadcast = false): PresenceObserver {
	return {
		start: async () => {
			log.push("start");
			if (failStart) throw new Error("start");
		},
		reconcile: async () => undefined,
		broadcast: async (_member, state) => {
			log.push(`broadcast:${state}`);
			if (failBroadcast) throw new Error("broadcast");
		},
		acceptHint: () => false,
		stop: () => {
			log.push("stop");
		},
		getState: () => ({}) as never,
	};
}

test("refresh is idempotent and role switch orders old offline, stop, new start", async () => {
	let membership: PresenceMembership | null = { member: a, notifications: true };
	const log: string[] = [];
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => membership,
		createObserver: () => fake(log),
		reportFailure: () => log.push("failure"),
	});
	await coordinator.refresh();
	await coordinator.refresh();
	assert.deepEqual(log, ["start"]);
	membership = { member: b, notifications: true };
	await coordinator.refresh();
	assert.deepEqual(log, ["start", "broadcast:offline", "stop", "start"]);
});

test("refresh, broadcast, and stop failures are isolated and cleanup continues", async () => {
	let membership: PresenceMembership | null = { member: a, notifications: true };
	const log: string[] = [];
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => membership,
		createObserver: () => fake(log, false, true),
		reportFailure: () => log.push("failure"),
	});
	await coordinator.refresh();
	membership = { member: b, notifications: true };
	await coordinator.refresh();
	await coordinator.stop();
	assert.deepEqual(log, [
		"start",
		"broadcast:offline",
		"failure",
		"stop",
		"start",
		"broadcast:offline",
		"failure",
		"stop",
	]);
	membership = { member: a, notifications: false };
	const startsBeforeDisabled = log.filter((item) => item === "start").length;
	await coordinator.refresh();
	assert.equal(log.filter((item) => item === "start").length, startsBeforeDisabled); // disabled refresh does not construct or start another observer
});

test("disabled membership constructs no observer", async () => {
	let created = 0;
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => ({ member: a, notifications: false }),
		createObserver: () => {
			created++;
			return fake([]);
		},
	});
	await coordinator.refresh();
	assert.equal(created, 0);
});
