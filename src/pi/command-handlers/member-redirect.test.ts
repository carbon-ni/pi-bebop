import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberRedirect } from "./member-redirect.ts";
test("member redirect rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberRedirect({ type: "member_redirect", target: "Mary", message: "x", instructions: [], id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member redirect delivers a valid message with steering intent", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	let command: unknown;
	c.state.memberMessageDependencies = {
		resolveEndpoint: async () => "mary-endpoint",
		coordinator: {
			enqueue: async (_key: string, operation: () => Promise<unknown>) => operation(),
			pendingKeyCount: () => 0,
		},
		transport: {
			send: async (_endpoint: string, sent: unknown) => {
				command = sent;
				return { response: { success: true, data: { deliveryId: "d2", disposition: "steered" } } as never };
			},
		},
	} as never;
	await handleMemberRedirect(
		{ type: "member_redirect", target: "Mary", message: "hello", instructions: ["step"], id: "1" },
		c,
	);
	assert.deepEqual((c.responses[0] as any).data.disposition, "steered");
	assert.equal((command as any).delivery, "immediate");
});
