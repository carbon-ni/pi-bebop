import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberIdleWait } from "./member-idle-wait.ts";
test("member idle wait rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberIdleWait({ type: "member_idle_wait", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
