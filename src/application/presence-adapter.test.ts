import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceObserverAdapter } from "./presence-adapter.ts";
import type { PresenceMembership } from "./presence-lifecycle.ts";
import type { PresenceMember } from "../domain/index.ts";

const lead: PresenceMember = { identity: "/crew/lead.sock", name: "lead", role: "lead" };
const dev: PresenceMember = { identity: "/crew/dev.sock", name: "dev", role: "developer" };
const qa: PresenceMember = { identity: "/crew/qa.sock", name: "qa", role: "qa" };
const membership: PresenceMembership = {
	member: lead,
	members: [lead, dev, qa],
	notifications: true,
	fingerprint: "v1",
};

test("adapter resolves configured peers, sends changed current payload with named timeout, and isolates failures", async () => {
	const resolved: string[] = [];
	const wires: Array<{ target: string; payload: unknown; timeout: number }> = [];
	const probes: string[] = [];
	const timers: Array<() => void> = [];
	const observer = createPresenceObserverAdapter(membership, "global-session-uuid", {
		scheduler: {
			schedule: (_delay, callback) => {
				timers.push(callback);
				return callback;
			},
			cancel: () => undefined,
		},
		probe: async (identity) => {
			probes.push(identity);
			return true;
		},
		resolveTarget: async (identity) => {
			const target = `global-${identity}`;
			resolved.push(target);
			return target;
		},
		send: async (target, payload, timeoutMs) => {
			wires.push({ target, payload, timeout: timeoutMs });
			if (target.endsWith("qa.sock")) throw new Error("peer timeout");
		},
		onEffects: () => undefined,
	});
	await observer.start();
	assert.deepEqual(probes, [dev.identity, qa.identity]);
	assert.deepEqual(resolved.sort(), ["global-/crew/dev.sock", "global-/crew/qa.sock"].sort());
	assert.equal(wires.length, 2);
	assert.equal(
		wires.every((wire) => wire.timeout === 500),
		true,
	);
	assert.equal(
		wires.some((wire) => JSON.stringify(wire.payload).includes("global-/crew/")),
		false,
	);
	assert.deepEqual(
		wires.map((wire) => (wire.payload as { member: PresenceMember }).member),
		[lead, lead],
	);
	assert.equal(timers.length, 1);
});

test("adapter sends old member as changed payload on offline broadcast and never targets self", async () => {
	const wires: Array<{ target: string; member: PresenceMember }> = [];
	const observer = createPresenceObserverAdapter(membership, "session", {
		scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
		probe: async () => true,
		resolveTarget: async (identity) => identity,
		send: async (target, payload) => {
			wires.push({ target, member: payload.member });
		},
		onEffects: () => undefined,
	});
	await observer.start();
	wires.length = 0;
	await observer.broadcast(lead, "offline");
	assert.deepEqual(wires.map((wire) => wire.target).sort(), [dev.identity, qa.identity].sort());
	assert.equal(
		wires.every((wire) => wire.member === lead),
		true,
	);
	assert.equal(
		wires.some((wire) => wire.target === lead.identity),
		false,
	);
});
