import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleCrewBroadcast } from "./crew-broadcast.ts";
test("crew broadcast rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleCrewBroadcast({ type: "crew_broadcast", message: "x", instructions: [], id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("crew broadcast persists one item for each configured peer", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.broadcastStoreDependencies = {
		isProjectTrusted: () => true,
		openStore: async () =>
			({
				memberKey: "mary",
				enqueue: async () => ({ item: {} }),
				enqueueWithId: async () => ({ alreadyPersisted: true, itemId: "b1" }),
			}) as never,
	} as never;
	await handleCrewBroadcast({ type: "crew_broadcast", message: "hello", instructions: ["one"], id: "1" }, c);
	assert.equal((c.responses[0] as any).data.broadcastId.startsWith("broadcast-"), true);
	assert.equal((c.responses[0] as any).data.dispositions.length, 1);
});
