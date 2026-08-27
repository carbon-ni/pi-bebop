import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handlePresenceHint } from "./presence-hint.ts";
test("presence hint acknowledges the observer result", async () => {
	const c = handlerContext();
	c.state.presenceObserver = { acceptHint: () => true } as never;
	await handlePresenceHint(
		{
			type: "presence_hint",
			member: { identity: "i", name: "Mary", role: "po" },
			state: "online",
			instanceId: "1",
			id: "x",
		},
		c,
	);
	assert.deepEqual(c.responses[0], { data: { accepted: true }, error: undefined });
});
