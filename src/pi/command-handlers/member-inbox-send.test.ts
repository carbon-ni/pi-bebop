import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberInboxSend } from "./member-inbox-send.ts";
test("member inbox send rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberInboxSend(
		{ type: "member_inbox_send", target: "Mary", message: "x", instructions: [], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
