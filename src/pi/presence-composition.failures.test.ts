import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceComposition } from "./presence-composition.ts";
import type { PresenceMembership } from "../application/presence-lifecycle.ts";
import { createPresenceObserver, type PresenceObserver } from "../application/presence-observer.ts";
import type { PresenceMember } from "../domain/index.ts";

const lead: PresenceMember = { identity: "lead", name: "lead", role: "lead" };
const membership: PresenceMembership = { member: lead, members: [lead], notifications: true, fingerprint: "v1" };
function fakeObserver(
	log: string[],
	options: { start?: boolean; broadcast?: boolean; stop?: boolean },
): PresenceObserver {
	return {
		start: async () => {
			log.push("start");
			if (options.start) throw new Error("start failed");
		},
		reconcile: async () => undefined,
		broadcast: async () => {
			log.push("broadcast");
			if (options.broadcast) throw new Error("broadcast failed");
		},
		acceptHint: () => false,
		stop: () => {
			log.push("stop");
			if (options.stop) throw new Error("stop failed");
		},
		getState: () => ({}) as never,
	};
}

function compositionFor(
	observer: PresenceObserver,
	report: string[],
	published: Array<PresenceObserver | undefined>,
	sendMessage: (message: unknown) => void = () => undefined,
) {
	return createPresenceComposition({
		getMembership: () => membership,
		createObserver: () => observer,
		sendMessage: ((message: unknown) => sendMessage(message)) as never,
		reportFailure: (error) => report.push(String(error)),
		onObserverChanged: (value) => published.push(value),
	});
}

test("enabled start failure is reported and public observer state is cleared", async () => {
	const log: string[] = [];
	const report: string[] = [];
	const published: Array<PresenceObserver | undefined> = [];
	const composition = compositionFor(fakeObserver(log, { start: true }), report, published);
	await assert.doesNotReject(composition.refresh());
	assert.deepEqual(log, ["start", "stop"]);
	assert.equal(report.length, 1);
	assert.deepEqual(published, [undefined]);
	await composition.stop();
	assert.deepEqual(log, ["start", "stop"]);
});

test("enabled offline broadcast failure is reported while stop and cleanup complete once", async () => {
	const log: string[] = [];
	const report: string[] = [];
	const published: Array<PresenceObserver | undefined> = [];
	const composition = compositionFor(fakeObserver(log, { broadcast: true }), report, published);
	await composition.refresh();
	await assert.doesNotReject(composition.stop());
	await composition.stop();
	assert.deepEqual(log, ["start", "broadcast", "stop"]);
	assert.equal(report.length, 1);
	assert.equal(published[0] !== undefined, true);
	assert.equal(published[1], undefined);
});

test("enabled stop failure is reported and public observer state is cleared", async () => {
	const log: string[] = [];
	const report: string[] = [];
	const published: Array<PresenceObserver | undefined> = [];
	const composition = compositionFor(fakeObserver(log, { stop: true }), report, published);
	await composition.refresh();
	await assert.doesNotReject(composition.stop());
	await composition.stop();
	assert.deepEqual(log, ["start", "broadcast", "stop"]);
	assert.equal(report.length, 1);
	assert.equal(published[0] !== undefined, true);
	assert.equal(published[1], undefined);
});

test("enabled sendMessage failure is reported without leaking a refresh promise", async () => {
	const report: string[] = [];
	const published: Array<PresenceObserver | undefined> = [];
	const composition = createPresenceComposition({
		getMembership: () => membership,
		createObserver: (_snapshot, onEffects) =>
			({
				start: async () => onEffects([{ type: "roster", members: [] }]),
				reconcile: async () => undefined,
				broadcast: async () => undefined,
				acceptHint: () => false,
				stop: () => undefined,
				getState: () => ({}) as never,
			}) as PresenceObserver,
		sendMessage: (() => {
			throw new Error("send failed");
		}) as never,
		reportFailure: (error) => report.push(String(error)),
		onObserverChanged: (value) => published.push(value),
	});
	await assert.doesNotReject(composition.refresh());
	assert.equal(report.length, 1);
	assert.deepEqual(published, [undefined]);
});

test("in-flight start stopped before probe completion emits no stale activity", async () => {
	let resolveProbe!: (value: boolean) => void;
	const messages: unknown[] = [];
	const report: string[] = [];
	const inflightMembership: PresenceMembership = {
		member: lead,
		members: [lead, { identity: "dev", name: "dev", role: "dev" }],
		notifications: true,
		fingerprint: "inflight",
	};
	const composition = createPresenceComposition({
		getMembership: () => inflightMembership,
		createObserver: (snapshot, onEffects) => {
			return createPresenceObserver(snapshot.members, snapshot.member.identity, "session", snapshot, {
				scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
				probe: async () =>
					await new Promise<boolean>((resolve) => {
						resolveProbe = resolve;
					}),
				sendHint: async () => undefined,
				onEffects,
			});
		},
		sendMessage: ((message: unknown) => messages.push(message)) as never,
		reportFailure: (error) => report.push(String(error)),
	});
	const starting = composition.refresh();
	await composition.stop();
	resolveProbe(true);
	await starting;
	assert.deepEqual(messages, []);
	assert.deepEqual(report, []);
});
