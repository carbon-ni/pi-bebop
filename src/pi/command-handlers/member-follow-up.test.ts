import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberFollowUp } from "./member-follow-up.ts";
test("member follow-up rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberFollowUp(
		{ type: "member_follow_up", target: "Mary", message: "x", instructions: [], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member follow-up delivers a valid message directly", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	c.state.memberMessageDependencies = {
		resolveEndpoint: async () => "mary-endpoint",
		coordinator: {
			enqueue: async (_key: string, operation: () => Promise<unknown>) => operation(),
			pendingKeyCount: () => 0,
		},
		transport: {
			send: async () => ({
				response: { success: true, data: { deliveryId: "d1", disposition: "direct" } } as never,
			}),
		},
	} as never;
	await handleMemberFollowUp(
		{ type: "member_follow_up", target: "Mary", message: "hello", instructions: ["step"], id: "1" },
		c,
	);
	assert.deepEqual((c.responses[0] as any).data, {
		member: { name: "Mary", role: "po" },
		deliveryId: "d1",
		disposition: "direct",
	});
});
