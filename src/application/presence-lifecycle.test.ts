import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceLifecycleCoordinator, type PresenceMembership } from "./presence-lifecycle.ts";
import type { PresenceObserver } from "./presence-observer.ts";
import type { PresenceMember } from "../domain/index.ts";

const a: PresenceMember = { identity: "/a", name: "a", role: "dev" };
const b: PresenceMember = { identity: "/b", name: "b", role: "qa" };
const makeMembership = (member: PresenceMember, fingerprint = member.identity): PresenceMembership => ({
	member,
	notifications: true,
	fingerprint,
	members: [a, b],
});
function fake(log: string[], failStart = false, failBroadcast = false, failStop = false): PresenceObserver {
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
			if (failStop) throw new Error("stop");
		},
		getState: () => ({}) as never,
	};
}

test("refresh is idempotent and role switch orders old offline, stop, new start", async () => {
	let membership: PresenceMembership | null = makeMembership(a);
	const log: string[] = [];
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => membership,
		createObserver: () => fake(log),
		reportFailure: () => log.push("failure"),
	});
	await coordinator.refresh();
	await coordinator.refresh();
	assert.deepEqual(log, ["start"]);
	membership = makeMembership(b);
	await coordinator.refresh();
	assert.deepEqual(log, ["start", "broadcast:offline", "stop", "start"]);
});

test("same identity with changed fingerprint replaces observer", async () => {
	let current = makeMembership(a, "v1");
	const log: string[] = [];
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => current,
		createObserver: () => fake(log),
	});
	await coordinator.refresh();
	current = makeMembership(a, "v2");
	await coordinator.refresh();
	assert.deepEqual(log, ["start", "broadcast:offline", "stop", "start"]);
});

test("same roster with a different current identity replaces observer", async () => {
	let current = makeMembership(a, "same-roster-a");
	const log: string[] = [];
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => current,
		createObserver: () => fake(log),
	});
	await coordinator.refresh();
	current = makeMembership(b, "same-roster-b");
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
	membership = makeMembership(b);
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
	membership = { ...makeMembership(a), notifications: false };
	const startsBeforeDisabled = log.filter((item) => item === "start").length;
	await coordinator.refresh();
	assert.equal(log.filter((item) => item === "start").length, startsBeforeDisabled); // disabled refresh does not construct or start another observer
});

test("throwing stop is isolated and clears public observer publication", async () => {
	let current = makeMembership(a);
	const log: string[] = [];
	const publications: Array<PresenceObserver | undefined> = [];
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => current,
		createObserver: () => fake(log, false, false, true),
		onObserverChanged: (observer) => publications.push(observer),
		reportFailure: () => log.push("failure"),
	});
	await coordinator.refresh();
	await coordinator.stop();
	await coordinator.stop();
	assert.deepEqual(log, ["start", "broadcast:offline", "stop", "failure"]);
	assert.equal(publications[0] !== undefined, true);
	assert.equal(publications[1], undefined);
});

test("disabled membership constructs no observer", async () => {
	let created = 0;
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: () => ({ ...makeMembership(a), notifications: false }),
		createObserver: () => {
			created++;
			return fake([]);
		},
	});
	await coordinator.refresh();
	assert.equal(created, 0);
});
