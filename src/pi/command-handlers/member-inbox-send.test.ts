import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberInboxSend } from "./member-inbox-send.ts";
test("member inbox send rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberInboxSend(
		{ type: "member_inbox_send", target: "Mary", message: "x", instructions: [], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member inbox send persists a valid item and reports its stable id", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.memberInboxMessageDependencies = {
		isProjectTrusted: () => true,
		resolveEndpoint: async () => "mary-endpoint",
		hintTransport: null,
		openStore: async () =>
			({
				memberKey: "mary",
				enqueue: async () => ({ item: { id: "item-1" } }),
				enqueueWithId: async () => ({ alreadyPersisted: true, itemId: "item-1" }),
			}) as never,
	} as never;
	await handleMemberInboxSend(
		{ type: "member_inbox_send", target: "Mary", message: "x", instructions: ["step"], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).data.persisted, true);
	assert.equal((c.responses[0] as any).data.member.name, "Mary");
});
