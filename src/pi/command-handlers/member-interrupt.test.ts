import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberInterrupt } from "./member-interrupt.ts";
test("member interrupt rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberInterrupt(
		{ type: "member_interrupt", target: "Mary", message: "x", instructions: [], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member interrupt returns the target acknowledgement", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	c.state.memberInterruptResolveEndpoint = async () => "mary-endpoint";
	c.state.memberInterruptSend = async () => ({
		response: { success: true, data: { interruptId: "i1", disposition: "direct" } } as never,
	});
	await handleMemberInterrupt(
		{ type: "member_interrupt", target: "Mary", message: "stop", instructions: ["step"], id: "1" },
		c,
	);
	assert.deepEqual((c.responses[0] as any).data, {
		member: { name: "Mary", role: "po" },
		interruptId: "i1",
		disposition: "direct",
	});
});
