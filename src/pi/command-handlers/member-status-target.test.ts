import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberStatusTarget } from "./member-status-target.ts";
test("member status target rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberStatusTarget({ type: "member_status_target", target: "Mary", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("member status target returns validated online peer status", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	c.state.memberStatusTransport = {
		probeEndpoint: async () => true,
		requestStatus: async () => ({
			ok: true,
			status: {
				member: { name: "Mary", role: "po" },
				presence: "online",
				activity: "idle",
				hasPendingMessages: false,
				observedAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	} as never;
	await handleMemberStatusTarget({ type: "member_status_target", target: "Mary", id: "1" }, c);
	assert.deepEqual((c.responses[0] as any).data.status.member, { name: "Mary", role: "po" });
});
