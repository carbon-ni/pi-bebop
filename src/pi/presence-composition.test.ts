import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceObserver } from "../application/presence-observer.ts";
import { createPresenceComposition } from "./presence-composition.ts";
import type { PresenceMembership } from "../application/presence-lifecycle.ts";
import type { PresenceMember } from "../domain/index.ts";

const lead: PresenceMember = { identity: "lead", name: "lead", role: "lead" };
const dev: PresenceMember = { identity: "dev", name: "Dev", role: "developer" };
const makeMembership = (current: PresenceMember, fingerprint: string): PresenceMembership => ({
	member: current,
	members: [lead, dev],
	notifications: true,
	fingerprint,
});

test("Pi composition covers startup, restore, reload/role switch, leave, stop, shutdown exactly once", async () => {
	let membership: PresenceMembership | null = makeMembership(lead, "lead-v1");
	let online = true;
	const messages: Array<{ content: string; options: unknown }> = [];
	let timer: (() => void) | undefined;
	let activeObserver: ReturnType<typeof createPresenceObserver> | undefined;
	const composition = createPresenceComposition({
		getMembership: () => membership,
		createObserver: (snapshot, onEffects) => {
			activeObserver = createPresenceObserver(
				snapshot.members,
				snapshot.member.identity,
				"session",
				{ notifications: snapshot.notifications },
				{
					scheduler: {
						schedule: (_d, callback) => {
							timer = callback;
							return callback;
						},
						cancel: () => undefined,
					},
					probe: async () => online,
					sendHint: async () => undefined,
					onEffects,
				},
			);
			return activeObserver;
		},
		sendMessage: ((message: unknown, options: unknown) =>
			messages.push({ content: (message as { content: string }).content, options })) as never,
	});
	await composition.startupSocketJoin();
	await composition.persistedRestore();
	assert.equal(messages.length, 1);
	online = false;
	await activeObserver!.reconcile();
	await activeObserver!.reconcile();
	assert.deepEqual(
		messages.map(({ content }) => content),
		["[crew] Online (2): lead (you), Dev (developer)", "[crew] Dev (developer) left"],
	);
	online = true;
	await activeObserver!.reconcile();
	assert.equal(messages.at(-1)?.content, "[crew] Dev (developer) joined");
	membership = makeMembership(dev, "dev-v2");
	await composition.reload();
	assert.equal(messages.at(-1)?.content, "[crew] Online (2): lead (lead), Dev (you)");
	const beforeStop = messages.length;
	await composition.leave();
	await composition.stopCommand();
	await composition.sessionShutdown();
	timer?.();
	assert.equal(messages.length, beforeStop);
	assert.equal(
		messages.every(({ options }) => JSON.stringify(options) === JSON.stringify({ triggerTurn: false })),
		true,
	);
});

test("Pi composition notifications false produces zero observer and message activity", async () => {
	let membership: PresenceMembership | null = { ...makeMembership(lead, "off"), notifications: false };
	let starts = 0;
	let sends = 0;
	const composition = createPresenceComposition({
		getMembership: () => membership,
		createObserver: () => {
			starts++;
			throw new Error("must not construct disabled observer");
		},
		sendMessage: (() => {
			sends++;
		}) as never,
		reportFailure: () => undefined,
	});
	await composition.startupSocketJoin();
	await composition.persistedRestore();
	await composition.leave();
	await composition.stopCommand();
	await composition.sessionShutdown();
	assert.deepEqual([starts, sends], [0, 0]);
});
