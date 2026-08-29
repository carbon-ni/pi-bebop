import test from "node:test";
import assert from "node:assert/strict";
import { AcceptedLocalMessageWakeGate, BlockingWaitSlot, createCrewIdleCapacity } from "../domain/index.ts";
import { registerWaitForCrewIdleTool } from "./wait-for-crew-idle.ts";

function setup(busy = false) {
	const registered: any[] = [];
	const io = { status: 0, state: 0, wait: 0 };
	const pi = { registerTool: (tool: unknown) => registered.push(tool) } as any;
	const members = [
		{ name: "Mony", role: "lead", socketPath: "/mony.sock" },
		{ name: "Dave", role: "dev", socketPath: "/dave.sock" },
		{ name: "Kelly", role: "qa", socketPath: "/kelly.sock" },
	];
	const state: any = {
		blockingWait: new BlockingWaitSlot({ now: () => "2026-08-29T10:00:00.000Z" }),
		wakeGate: new AcceptedLocalMessageWakeGate(),
		crewIdleCapacity: createCrewIdleCapacity(),
		membershipRuntime: { getMembership: () => ({ member: members[0], manifest: { members } }) },
		context: { isProjectTrusted: () => true },
	};
	registerWaitForCrewIdleTool(pi, state, {
		requestStatus: async (member) => {
			io.status += 1;
			return {
				ok: true,
				status: {
					member,
					presence: "online",
					activity: busy ? "busy" : "idle",
					hasPendingMessages: false,
					observedAt: "2026-08-29T10:00:00.000Z",
				},
			};
		},
		requestWaitState: async (member) => {
			io.state += 1;
			return { ok: true, snapshot: { member, wait: null } };
		},
		requestMemberIdle: async () => {
			io.wait += 1;
			return busy ? new Promise<never>(() => undefined) : { ok: true, outcome: "became-idle" };
		},
	});
	return { tool: registered[0], state, io };
}

test("wait_for_crew_idle exposes only bounded optional selection and timeout", () => {
	const { tool } = setup();
	assert.equal(tool.name, "wait_for_crew_idle");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["members", "timeout_seconds"]);
	assert.match(tool.description, /final status round/i);
});

test("wait_for_crew_idle exposes frozen targets and observation caveat in model-visible text", async () => {
	const { tool } = setup();
	const result = await tool.execute("id", { members: ["Dave"] });
	const text = result.content[0].text;
	assert.match(text, /targets: Dave \(dev\)/);
	assert.match(text, /coversAllOtherMembers: false/);
	assert.match(text, /observedAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
	assert.match(text, /momentary distributed observation, not a whole-Crew atomic state/);
});

test("wait_for_crew_idle rejects behind an active slash command before IO", async () => {
	const { tool, state, io } = setup();
	state.crewMemberIdleCommand = { cancel: () => undefined };
	const result = await tool.execute("id", {});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /wait-in-progress/);
	assert.deepEqual(io, { status: 0, state: 0, wait: 0 });
	assert.equal(state.blockingWait.activeMarker(), null);
});

test("wait_for_crew_idle rejects behind an active slash capacity lease before IO", async () => {
	const { tool, state, io } = setup();
	const lease = state.crewIdleCapacity.acquire();
	assert.ok(lease);
	const result = await tool.execute("id", {});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /wait-in-progress/);
	assert.deepEqual(io, { status: 0, state: 0, wait: 0 });
	assert.equal(state.blockingWait.activeMarker(), null);
	lease.release();
});

test("wait_for_crew_idle releases the crew marker on normal completion", async () => {
	const { tool, state } = setup();
	const result = await tool.execute("id", {});
	assert.equal(result.details.result.outcome, "ready");
	assert.equal(state.blockingWait.activeMarker(), null);
});

test("wait_for_crew_idle wake keeps the frozen selected manifest scope", async () => {
	const { tool, state } = setup(true);
	const original = state.membershipRuntime.getMembership;
	const promise = tool.execute("id", { members: ["Dave"] });
	await new Promise((resolve) => setTimeout(resolve, 0));
	state.membershipRuntime.getMembership = () => ({
		...original(),
		manifest: { members: [original().member, { name: "Kelly", role: "qa", socketPath: "/kelly.sock" }] },
	});
	assert.equal(state.wakeGate.notifyAccepted("delivery-selected"), true);
	const result = await promise;
	assert.equal(result.details.result.outcome, "message-received");
	assert.deepEqual(result.details.result.members, [{ name: "Dave", role: "dev" }]);
});

test("wait_for_crew_idle wakes on an accepted local message and terminates the continuation", async () => {
	const { tool, state } = setup(true);
	const promise = tool.execute("id", {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(state.wakeGate.notifyAccepted("delivery-1"), true);
	const result = await Promise.race([
		promise,
		new Promise<any>((_, reject) => setTimeout(() => reject(new Error("stuck")), 1000)),
	]);
	assert.equal(result.terminate, true);
	assert.equal(result.details.result.outcome, "message-received");
	assert.equal(state.blockingWait.activeMarker(), null);
});
