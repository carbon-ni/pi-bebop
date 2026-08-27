import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberResponse } from "./member-response.ts";
test("member response rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberResponse({ type: "member_response", requestId: "r", message: "x", instructions: [], id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
