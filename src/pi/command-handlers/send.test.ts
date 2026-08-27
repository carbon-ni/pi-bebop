import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleSend } from "./send.ts";
test("send rejects an invalid structured payload", async () => {
	const c = handlerContext();
	await handleSend({ type: "send", payload: {} as never, id: "1" }, c);
	assert.equal((c.responses[0] as any).error, "Invalid structured message payload");
});

test("send acknowledges a valid escaped payload and delivers it", async () => {
	const c = handlerContext();
	const sent: unknown[] = [];
	c.pi.sendMessage = ((message: unknown, options: unknown) => sent.push({ message, options })) as never;
	await handleSend(
		{
			type: "send",
			payload: {
				content: 'quote " and slash \\',
				instructions: ["step"],
				origin: { kind: "external", label: "cli" },
			},
			id: "42",
		},
		c,
	);
	assert.equal(sent.length, 1);
	assert.equal((c.responses[0] as any).data.disposition, "direct");
	assert.match((c.responses[0] as any).data.deliveryId, /^delivery-test-id$/);
});
