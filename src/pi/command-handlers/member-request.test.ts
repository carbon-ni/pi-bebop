import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberRequest } from "./member-request.ts";
test("member request rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "r",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member request registers and acknowledges a configured crew origin", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	let registered = false;
	c.state.memberRequestFlow = {
		registerInboundRequest: () => {
			registered = true;
		},
		acceptInboundRequest: () => undefined,
		removeInboundRequest: () => undefined,
		registry: { failBeforeAcceptance: () => undefined },
	} as never;
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "r",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal(registered, true);
	assert.deepEqual((c.responses[0] as any).data, {
		accepted: true,
		requestId: "r",
		member: { name: "Dave", role: "dev" },
	});
});
