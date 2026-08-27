import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberIdleWait } from "./member-idle-wait.ts";
test("member idle wait rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberIdleWait({ type: "member_idle_wait", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member idle wait acknowledges an already-idle joined runtime", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	await handleMemberIdleWait({ type: "member_idle_wait", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { subscriptionId: "test-id", event: "member_idle" });
	assert.equal(c.state.idleWaitSubscriptions.length, 0);
});
