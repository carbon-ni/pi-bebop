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

test("one-member crews return ready with the no-other-members reason", async () => {
	const surface = surfaceFor({});
	(surface as any).getMembership = () => ({
		member: identity("Mony", "lead"),
		manifest: { members: [identity("Mony", "lead")] },
	});
	const result = await createCrewIdleWaitFlow(surface).wait({});
	assert.equal(result.outcome, "ready");
	assert.equal(result.reason, "no-other-members");
});

test("offline status wins when paired wait-state transport fails", async () => {
	const surface = surfaceFor({ Dave: "busy", Kelly: "busy" });
	surface.requestStatus = async (member) =>
		member.name === "Dave"
			? {
					ok: true,
					status: {
						...status(member, "idle"),
						presence: "offline" as const,
						activity: "unavailable",
						hasPendingMessages: "unavailable",
					},
				}
			: { ok: true, status: status(member, "busy") };
	surface.requestWaitState = async () => ({ ok: false, code: "transport-error" });
	const result = await createCrewIdleWaitFlow(surface).wait({});
	assert.equal(result.outcome, "offline");
	assert.equal(result.blockers?.[0]?.status, "offline");
});

test("crew idle flow maps membership loss during the operation", async () => {
	const surface = surfaceFor({ Dave: "idle", Kelly: "idle" });
	const initial = surface.getMembership();
	let calls = 0;
	(surface as any).getMembership = () => {
		calls += 1;
		return calls > 1 ? null : initial;
	};
	await assert.rejects(
		createCrewIdleWaitFlow(surface).wait({}),
		(error: { code?: string }) => error.code === "membership-lost",
	);
});

test("crew idle flow rejects a pre-aborted caller before starting transport or a timeout", async () => {
	const controller = new AbortController();
	controller.abort();
	const surface = surfaceFor({ Dave: "busy", Kelly: "busy" });
	let statusCalls = 0;
	const requestStatus = surface.requestStatus;
	surface.requestStatus = async (...args) => {
		statusCalls += 1;
		return requestStatus(...args);
	};
	await assert.rejects(
		createCrewIdleWaitFlow(surface).wait({ signal: controller.signal }),
		(error: { code?: string }) => error.code === "aborted",
	);
	assert.equal(statusCalls, 0);
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
