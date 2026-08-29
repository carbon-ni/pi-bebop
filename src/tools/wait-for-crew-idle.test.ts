import test from "node:test";
import assert from "node:assert/strict";
import { AcceptedLocalMessageWakeGate, BlockingWaitSlot } from "../domain/index.ts";
import { registerWaitForCrewIdleTool } from "./wait-for-crew-idle.ts";

function setup(busy = false) {
	const registered: any[] = [];
	const pi = { registerTool: (tool: unknown) => registered.push(tool) } as any;
	const members = [
		{ name: "Mony", role: "lead", socketPath: "/mony.sock" },
		{ name: "Dave", role: "dev", socketPath: "/dave.sock" },
	];
	const state: any = {
		blockingWait: new BlockingWaitSlot({ now: () => "2026-08-29T10:00:00.000Z" }),
		wakeGate: new AcceptedLocalMessageWakeGate(),
		membershipRuntime: { getMembership: () => ({ member: members[0], manifest: { members } }) },
		context: { isProjectTrusted: () => true },
	};
	registerWaitForCrewIdleTool(pi, state, {
		requestStatus: async (member) => ({
			ok: true,
			status: {
				member,
				presence: "online",
				activity: busy ? "busy" : "idle",
				hasPendingMessages: false,
				observedAt: "2026-08-29T10:00:00.000Z",
			},
		}),
		requestWaitState: async (member) => ({ ok: true, snapshot: { member, wait: null } }),
		requestMemberIdle: async () =>
			busy ? new Promise<never>(() => undefined) : { ok: true, outcome: "became-idle" },
	});
	return { tool: registered[0], state };
}

test("wait_for_crew_idle exposes only bounded optional selection and timeout", () => {
	const { tool } = setup();
	assert.equal(tool.name, "wait_for_crew_idle");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["members", "timeout_seconds"]);
	assert.match(tool.description, /final status round/i);
});

test("wait_for_crew_idle releases the crew marker on normal completion", async () => {
	const { tool, state } = setup();
	const result = await tool.execute("id", {});
	assert.equal(result.details.result.outcome, "ready");
	assert.equal(state.blockingWait.activeMarker(), null);
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
