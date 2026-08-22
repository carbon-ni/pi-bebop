import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceObserver } from "./presence-observer.ts";
import { emitCrewPresenceActivity } from "./presence-activity.ts";
import type { PresenceMember } from "../domain/index.ts";

const lead: PresenceMember = { identity: "lead", name: "lead", role: "lead" };
const dev: PresenceMember = { identity: "dev", name: "Dev", role: "developer" };
const qa: PresenceMember = { identity: "qa", name: "QA", role: "qa" };

test("controlled observer effects produce exact chat activity through crash/rejoin and stop", async () => {
	let online = true;
	let callback: (() => void) | undefined;
	let staleResolve: ((value: boolean) => void) | undefined;
	const messages: Array<{ content: string; options: { triggerTurn: false } }> = [];
	const configured = [lead, dev, qa];
	const membership = { members: configured, currentIdentity: lead.identity, notifications: true };
	const observer = createPresenceObserver(
		configured,
		lead.identity,
		"session",
		{ notifications: true },
		{
			scheduler: {
				schedule: (_delay, cb) => {
					callback = cb;
					return cb;
				},
				cancel: () => undefined,
			},
			probe: async (identity) => {
				if (identity === dev.identity && staleResolve)
					return await new Promise<boolean>((resolve) => {
						staleResolve = resolve;
					});
				return online;
			},
			sendHint: async () => undefined,
			onEffects: (effects) =>
				emitCrewPresenceActivity(effects, membership, (message, options) =>
					messages.push({ content: message.content, options }),
				),
		},
	);
	await observer.start();
	assert.deepEqual(
		messages.map((message) => message.content),
		["[crew] Online (3): lead (you), Dev (developer), QA (qa)"],
	);
	online = false;
	await observer.reconcile();
	await observer.reconcile();
	assert.deepEqual(
		messages.map((message) => message.content),
		[
			"[crew] Online (3): lead (you), Dev (developer), QA (qa)",
			"[crew] Dev (developer) left",
			"[crew] QA (qa) left",
		],
	);
	online = true;
	await observer.reconcile();
	assert.deepEqual(
		messages.slice(-2).map((message) => message.content),
		["[crew] Dev (developer) joined", "[crew] QA (qa) joined"],
	);
	const beforeStop = messages.length;
	observer.stop();
	callback?.();
	assert.equal(messages.length, beforeStop);
	assert.equal(
		messages.every((message) => message.options.triggerTurn === false),
		true,
	);
	void staleResolve;
});

test("disabled chat pipeline emits no initial, transition, or stale activity", async () => {
	let probes = 0;
	let messages = 0;
	const observer = createPresenceObserver(
		[lead, dev],
		lead.identity,
		"session",
		{ notifications: false },
		{
			scheduler: {
				schedule: () => {
					throw new Error("must not schedule");
				},
				cancel: () => undefined,
			},
			probe: async () => {
				probes++;
				return true;
			},
			sendHint: async () => {
				messages++;
			},
			onEffects: () => {
				messages++;
			},
		},
	);
	await observer.start();
	await observer.reconcile();
	observer.stop();
	assert.equal(probes, 0);
	assert.equal(messages, 0);
});
