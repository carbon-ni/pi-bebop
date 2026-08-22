import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceObserver } from "./presence-observer.ts";
import type { PresenceMember } from "../domain/index.ts";

const lead: PresenceMember = { identity: "/crew/lead.sock", name: "lead", role: "lead" };
const dev: PresenceMember = { identity: "/crew/dev.sock", name: "dev", role: "developer" };
const qa: PresenceMember = { identity: "/crew/qa.sock", name: "qa", role: "qa" };
function harness(notifications = true) {
	const timers: Array<() => void> = [];
	const probes: string[] = [];
	const effects: unknown[] = [];
	const hints: string[] = [];
	const answers = new Map<string, boolean>();
	const observer = createPresenceObserver(
		[lead, dev, qa],
		lead.identity,
		"self",
		{ notifications },
		{
			scheduler: {
				schedule: (_delay, callback) => {
					timers.push(callback);
					return callback;
				},
				cancel: (handle) => {
					const index = timers.indexOf(handle as () => void);
					if (index >= 0) timers.splice(index, 1);
				},
			},
			probe: async (identity) => {
				probes.push(identity);
				return answers.get(identity) ?? true;
			},
			sendHint: async (member, state) => {
				hints.push(`${member.identity}:${state}`);
			},
			onEffects: (items) => effects.push(...items),
		},
	);
	return { observer, timers, probes, effects, hints, answers };
}

test("initial scan probes non-current concurrently, emits ordered roster, and hints peers", async () => {
	const h = harness();
	h.answers.set(dev.identity, true);
	h.answers.set(qa.identity, false);
	await h.observer.start();
	assert.deepEqual(h.probes, [dev.identity, qa.identity]);
	assert.deepEqual(
		(h.effects[0] as { members: PresenceMember[] }).members.map((m) => m.identity),
		[dev.identity, qa.identity],
	);
	assert.deepEqual(h.hints.sort(), [`${dev.identity}:online`, `${qa.identity}:online`].sort());
	assert.equal(h.timers.length, 1);
});

test("hint validates claimed active identity, never mutates directly, and probes once", async () => {
	const h = harness();
	await h.observer.start();
	h.probes.length = 0;
	assert.equal(h.observer.acceptHint({ member: dev, state: "offline", instanceId: "peer" }), true);
	assert.equal(
		h.observer.acceptHint({ member: { ...dev, name: "wrong" }, state: "offline", instanceId: "peer" }),
		false,
	);
	assert.equal(h.observer.acceptHint({ member: dev, state: "offline", instanceId: "self" }), false);
	assert.equal(h.observer.getState().members[dev.identity], "online");
	await Promise.resolve();
	assert.deepEqual(h.probes, [dev.identity]);
});

test("unknown identity and mismatched role are no-ops", async () => {
	const h = harness();
	await h.observer.start();
	h.probes.length = 0;
	assert.equal(
		h.observer.acceptHint({
			member: { identity: "/missing", name: "dev", role: "developer" },
			state: "online",
			instanceId: "peer",
		}),
		false,
	);
	assert.equal(
		h.observer.acceptHint({ member: { ...dev, role: "wrong" }, state: "online", instanceId: "peer" }),
		false,
	);
	assert.deepEqual(h.probes, []);
});

test("stale in-flight reconciliation is ignored after stop and timer is cancelled", async () => {
	let resolveProbe!: (value: boolean) => void;
	const h = harness();
	const probe = h.observer;
	await probe.start();
	const before = probe.getState();
	probe.stop();
	assert.equal(h.timers.length, 0);
	assert.equal(before, probe.getState());
	resolveProbe?.(false);
});

test("disabled notifications create no probes, hints, effects, or timers", async () => {
	const h = harness(false);
	await h.observer.start();
	assert.deepEqual(h.probes, []);
	assert.deepEqual(h.hints, []);
	assert.deepEqual(h.effects, []);
	assert.deepEqual(h.timers, []);
	assert.equal(h.observer.acceptHint({ member: dev, state: "online", instanceId: "peer" }), false);
});

test("reconciliation probe failures are isolated and later scans remain available", async () => {
	const h = harness();
	let reject = true;
	const observer = createPresenceObserver(
		[lead, dev],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
			probe: async () => {
				if (reject) {
					reject = false;
					throw new Error("offline");
				}
				return true;
			},
			sendHint: async () => {
				throw new Error("peer crashed");
			},
			onEffects: (effects) => h.effects.push(...effects),
		},
	);
	await observer.start();
	assert.equal(observer.getState().members[dev.identity], "suspect");
	await observer.reconcile();
	assert.equal(observer.getState().members[dev.identity], "online");
});
