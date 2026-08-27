import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberFollowUp } from "./member-follow-up.ts";
test("member follow-up rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberFollowUp(
		{ type: "member_follow_up", target: "Mary", message: "x", instructions: [], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
