import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberStatusTarget } from "./member-status-target.ts";
test("member status target rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberStatusTarget({ type: "member_status_target", target: "Mary", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
