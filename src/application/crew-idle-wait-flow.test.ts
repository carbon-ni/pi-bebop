import test from "node:test";
import assert from "node:assert/strict";
import { BlockingWaitSlot, type MemberStatus } from "../domain/index.ts";
import { createCrewIdleWaitFlow, type CrewIdleWaitSurface } from "./crew-idle-wait-flow.ts";

const identity = (name: string, role = name.toLowerCase()) => ({ name, role, socketPath: `/${name}.sock` });
const status = (member: ReturnType<typeof identity>, activity: "idle" | "busy" | "compacting"): MemberStatus => ({
	member,
	presence: "online",
	activity,
	hasPendingMessages: false,
	observedAt: "2026-08-29T10:00:00.000Z",
});

function surfaceFor(activities: Record<string, "idle" | "busy" | "compacting">): CrewIdleWaitSurface {
	const members = [identity("Mony", "lead"), identity("Dave", "dev"), identity("Kelly", "qa")];
	const current = { ...activities };
	return {
		getMembership: () => ({ member: members[0], manifest: { members } }),
		isTrusted: () => true,
		requestStatus: async (member, _signal) => ({
			ok: true,
			status: status(member, current[member.name] ?? "idle"),
		}),
		requestWaitState: async (member, { onTransition }) => ({
			ok: true,
			snapshot: { member: { name: member.name, role: member.role }, wait: null },
			onTransition,
		}),
		requestMemberIdle: async (member) => {
			current[member.name] = "idle";
			return { ok: true, outcome: "became-idle" as const };
		},
		now: () => "2026-08-29T10:00:00.000Z",
		nowMs: () => 1_000,
	};
}

test("crew idle flow returns initial ready for all idle and final ready after concurrent waits", async () => {
	const initial = await createCrewIdleWaitFlow(surfaceFor({ Dave: "idle", Kelly: "idle" })).wait({});
	assert.equal(initial.outcome, "ready");
	assert.equal(initial.reason, "initial-round");

	const flow = createCrewIdleWaitFlow(surfaceFor({ Dave: "busy", Kelly: "busy" }), { roundCap: 3 });
	const result = await flow.wait({ members: ["Kelly", "Dave"] });
	assert.equal(result.outcome, "ready");
	assert.equal(result.reason, "after-wait");
	assert.deepEqual(
		result.members.map((member) => member.name),
		["Dave", "Kelly"],
	);
});

test("crew idle flow returns offline and bounded unstable blockers without serial waits", async () => {
	const surface = surfaceFor({ Dave: "busy", Kelly: "busy" });
	let calls = 0;
	surface.requestStatus = async (member) => {
		calls += 1;
		if (member.name === "Kelly")
			return {
				ok: true,
				status: {
					...status(member, "idle"),
					presence: "offline" as const,
					activity: "unavailable",
					hasPendingMessages: "unavailable",
				},
			};
		return { ok: true, status: status(member, "busy") };
	};
	const offline = await createCrewIdleWaitFlow(surface).wait({});
	assert.equal(offline.outcome, "offline");
	assert.ok(calls >= 2);
});

test("crew idle flow detects a full explicit wait-lock but not a selected subset", async () => {
	const slot = new BlockingWaitSlot({ now: () => "2026-08-29T10:00:00.000Z" });
	slot.acquire("crew-idle");
	const surface = surfaceFor({ Dave: "busy", Kelly: "busy" });
	surface.requestWaitState = async (member) => ({
		ok: true,
		snapshot: {
			member: { name: member.name, role: member.role },
			wait: { kind: "member-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		},
		onTransition: () => undefined,
	});
	const result = await createCrewIdleWaitFlow(surface).wait({ callerWait: slot.activeMarker() });
	assert.equal(result.outcome, "wait-lock");
	const subset = await createCrewIdleWaitFlow(surface).wait({ members: ["Dave"], callerWait: slot.activeMarker() });
	assert.notEqual(subset.outcome, "wait-lock");
});
