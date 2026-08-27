import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleCrewBroadcast } from "./crew-broadcast.ts";
test("crew broadcast rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleCrewBroadcast({ type: "crew_broadcast", message: "x", instructions: [], id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "not-joined");
});
