import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleClear } from "./clear.ts";
test("clear rejects a busy context", async () => {
	const c = handlerContext();
	c.ctx.isIdle = () => false;
	await handleClear({ type: "clear", id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "Session is busy - wait for turn to complete");
});

test("clear rewinds to the first entry when idle", async () => {
	const c = handlerContext();
	let rewoundTo = "";
	c.ctx.sessionManager = {
		getEntries: () => [
			{ id: "root", parentId: null },
			{ id: "leaf", parentId: "root" },
		],
		getLeafId: () => "leaf",
		rewindTo: (id: string) => {
			rewoundTo = id;
		},
	} as never;
	await handleClear({ type: "clear", id: "1" }, c);
	assert.equal(rewoundTo, "root");
	assert.deepEqual((c.responses[0] as any).data, { cleared: true, targetId: "root" });
});
