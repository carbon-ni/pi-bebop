import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberRequest } from "./member-request.ts";
test("member request rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "r",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
