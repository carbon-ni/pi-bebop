import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberResponse } from "./member-response.ts";
test("member response rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberResponse({ type: "member_response", requestId: "r", message: "x", instructions: [], id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member response forwards a correlated response to the request flow", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	let received: unknown;
	c.state.memberRequestFlow = {
		respondToMemberRequest: async (value: unknown) => {
			received = value;
		},
	} as never;
	await handleMemberResponse(
		{ type: "member_response", requestId: "r", message: "answer", instructions: ["next"], id: "1" },
		c,
	);
	assert.deepEqual(received, {
		message: "answer",
		instructions: ["next"],
		requestId: "r",
		member: { name: "Dave", role: "dev" },
	});
	assert.deepEqual((c.responses[0] as any).data, {});
});
