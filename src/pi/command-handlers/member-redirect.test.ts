import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberRedirect } from "./member-redirect.ts";
test("member redirect rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberRedirect({ type: "member_redirect", target: "Mary", message: "x", instructions: [], id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
