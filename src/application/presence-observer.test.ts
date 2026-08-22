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
	const timeouts: number[] = [];
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
			probe: async (identity, timeout) => {
				probes.push(identity);
				timeouts.push(timeout);
				return answers.get(identity) ?? true;
			},
			sendHint: async (target, changed, state) => {
				hints.push(`${target.identity}<-${changed.identity}:${state}`);
			},
			onEffects: (items) => effects.push(...items),
		},
	);
	return { observer, timers, probes, timeouts, effects, hints, answers };
}

test("initial scan probes non-current concurrently, emits ordered roster, and hints peers", async () => {
	const h = harness();
	h.answers.set(dev.identity, true);
	h.answers.set(qa.identity, false);
	await h.observer.start();
	assert.deepEqual(h.probes, [dev.identity, qa.identity]);
	assert.deepEqual(h.timeouts, [500, 500]);
	assert.deepEqual(
		(h.effects[0] as { members: PresenceMember[] }).members.map((m) => m.identity),
		[dev.identity, qa.identity],
	);
	assert.deepEqual(
		h.hints.sort(),
		[`${dev.identity}<-${lead.identity}:online`, `${qa.identity}<-${lead.identity}:online`].sort(),
	);
	assert.equal(h.timers.length, 1);
	const probesBeforeDuplicate = h.probes.length;
	await h.observer.start();
	assert.equal(h.probes.length, probesBeforeDuplicate);
});

test("reverse probe completion retains manifest order", async () => {
	const pending = new Map<string, (value: boolean) => void>();
	const effects: unknown[] = [];
	const observer = createPresenceObserver(
		[lead, dev, qa],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
			probe: async (identity) => await new Promise<boolean>((resolve) => pending.set(identity, resolve)),
			sendHint: async () => undefined,
			onEffects: (items) => effects.push(...items),
		},
	);
	const started = observer.start();
	pending.get(qa.identity)!(false);
	pending.get(dev.identity)!(true);
	await started;
	assert.deepEqual(
		(effects[0] as { members: PresenceMember[] }).members.map((item) => item.identity),
		[dev.identity, qa.identity],
	);
});

test("hint during initial scan waits for the complete ordered roster", async () => {
	const pending: Array<{ identity: string; resolve: (online: boolean) => void }> = [];
	const effects: unknown[] = [];
	const observer = createPresenceObserver(
		[lead, dev, qa],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
			probe: (identity) => new Promise<boolean>((resolve) => pending.push({ identity, resolve })),
			sendHint: async () => undefined,
			onEffects: (items) => effects.push(...items),
		},
	);
	const started = observer.start();
	assert.equal(observer.acceptHint({ member: dev, state: "online", instanceId: "peer" }), true);
	pending.find((item) => item.identity === qa.identity)!.resolve(false);
	pending.find((item) => item.identity === dev.identity)!.resolve(true);
	await started;
	assert.equal(pending.length, 3);
	pending.find((item, index) => item.identity === dev.identity && index === 2)!.resolve(true);
	await Promise.resolve();
	assert.deepEqual(
		(effects[0] as { members: PresenceMember[] }).members.map((item) => item.identity),
		[dev.identity, qa.identity],
	);
	assert.equal(
		effects.filter(
			(effect) =>
				(effect as { type?: string }).type === "joined" || (effect as { type?: string }).type === "left",
		).length,
		0,
	);
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

test("stale in-flight reconciliation and hint are ignored after stop", async () => {
	const timers: Array<() => void> = [];
	const pending: Array<(value: boolean) => void> = [];
	const effects: unknown[] = [];
	const observer = createPresenceObserver(
		[lead, dev],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: {
				schedule: (_delay, callback) => {
					timers.push(callback);
					return callback;
				},
				cancel: () => undefined,
			},
			probe: async () => await new Promise<boolean>((resolve) => pending.push(resolve)),
			sendHint: async () => undefined,
			onEffects: (items) => effects.push(...items),
		},
	);
	const started = observer.start();
	assert.equal(pending.length, 1);
	observer.stop();
	pending[0]!(false);
	await started;
	assert.equal(timers.length, 0);
	assert.equal(observer.acceptHint({ member: dev, state: "online", instanceId: "peer" }), false);
	assert.deepEqual(effects, []);
	await observer.reconcile();
	assert.deepEqual(effects, []);
	observer.stop();
	observer.stop();
});

test("missing current identity rejects start without probing or hints", async () => {
	const h = harness();
	const observer = createPresenceObserver(
		[dev],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
			probe: async () => {
				throw new Error("must not probe");
			},
			sendHint: async () => {
				throw new Error("must not hint");
			},
			onEffects: () => {
				throw new Error("must not effect");
			},
		},
	);
	await observer.start();
	assert.equal(observer.acceptHint({ member: dev, state: "online", instanceId: "peer" }), false);
	assert.deepEqual(h.probes, []);
});

test("dequeued timer from old generation cannot scan or reschedule after restart", async () => {
	const callbacks: Array<() => void> = [];
	const cancelled: Array<() => void> = [];
	let probes = 0;
	const observer = createPresenceObserver(
		[lead, dev],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: {
				schedule: (_d, cb) => {
					callbacks.push(cb);
					return cb;
				},
				cancel: (handle) => {
					cancelled.push(handle as () => void);
				},
			},
			probe: async () => {
				probes += 1;
				return true;
			},
			sendHint: async () => undefined,
			onEffects: () => undefined,
		},
	);
	await observer.start();
	const old = callbacks[0]!;
	observer.stop();
	await observer.start();
	const afterRestart = probes;
	old();
	await Promise.resolve();
	assert.equal(probes, afterRestart);
	observer.stop();
	assert.equal(cancelled.at(-1), callbacks[1]);
	callbacks[1]!();
	await Promise.resolve();
	assert.equal(probes, afterRestart);
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

test("offline broadcast targets every peer with changed current member and isolates failures", async () => {
	const h = harness();
	const sent: string[] = [];
	const observer = createPresenceObserver(
		[lead, dev, qa],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
			probe: async () => true,
			sendHint: async (target, changed, state) => {
				sent.push(`${target.identity}<-${changed.identity}:${state}`);
				if (target.identity === qa.identity) throw new Error("slow peer");
			},
			onEffects: () => undefined,
		},
	);
	await observer.start();
	sent.length = 0;
	await observer.broadcast(lead, "offline");
	assert.deepEqual(sent, [`${dev.identity}<-${lead.identity}:offline`, `${qa.identity}<-${lead.identity}:offline`]);
	observer.stop();
	await observer.broadcast(lead, "offline");
	assert.deepEqual(sent, [`${dev.identity}<-${lead.identity}:offline`, `${qa.identity}<-${lead.identity}:offline`]);
});

test("two failed reconciles emit one left for a crashed member", async () => {
	const h = harness();
	h.answers.set(dev.identity, false);
	await h.observer.start();
	h.effects.length = 0;
	await h.observer.reconcile();
	const left = h.effects.filter((effect) => (effect as { type?: string }).type === "left");
	assert.deepEqual(left, [{ type: "left", member: dev }]);
	await h.observer.reconcile();
	assert.equal(h.effects.filter((effect) => (effect as { type?: string }).type === "left").length, 1);
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
