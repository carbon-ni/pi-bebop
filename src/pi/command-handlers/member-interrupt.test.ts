import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleMemberInterrupt } from "./member-interrupt.ts";
test("member interrupt rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberInterrupt(
		{ type: "member_interrupt", target: "Mary", message: "x", instructions: [], id: "1" },
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
