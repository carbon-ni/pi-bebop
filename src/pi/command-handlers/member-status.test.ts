import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberStatus } from "./member-status.ts";
test("member status rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberStatus({ type: "member_status", member: "Mary", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
