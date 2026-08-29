import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext } from "./test-support.ts";
import { handleSend } from "./send.ts";
import { SESSION_MESSAGE_TYPE } from "../../domain/index.ts";
import { QueuedFollowUpAcceptanceRegistry } from "../../domain/index.ts";

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
		} as never,
		c,
	);
	assert.equal(sent.length, 1);
	assert.equal((c.responses[0] as any).data.disposition, "direct");
	assert.match((c.responses[0] as any).data.deliveryId, /^delivery-test-id$/);
});

test("busy ordinary Follow-up acknowledges queued, seeds deliveryId, and records acceptance", async () => {
	const c = handlerContext();
	c.ctx.isIdle = () => false;
	c.state.queuedFollowUps = new QueuedFollowUpAcceptanceRegistry({ now: () => 1_000 });
	const sent: unknown[] = [];
	c.pi.sendMessage = ((message: unknown, options: unknown) => sent.push({ message, options })) as never;
	await handleSend({ type: "send", payload: { content: "old update" }, id: "q1" }, c);
	assert.deepEqual((c.responses[0] as any).data, { deliveryId: "delivery-q1", disposition: "queued" });
	assert.equal(sent.length, 1);
	const message = (sent[0] as { message: Record<string, unknown> }).message;
	assert.equal(message.customType, SESSION_MESSAGE_TYPE);
	assert.deepEqual((message.details as Record<string, unknown>).deliveryId, "delivery-q1");
	assert.equal((message.details as Record<string, unknown>).deliveryProvenance, undefined);
	assert.deepEqual(c.state.queuedFollowUps.claimHandoff("delivery-q1"), {
		deliveryId: "delivery-q1",
		acceptedAt: 1_000,
		handoffAt: 1_000,
		queueDelay: "0s",
		disposition: "queued",
	});
});

test("direct and steered deliveries record no acceptance and seed no deliveryId", async () => {
	const direct = handlerContext();
	direct.state.queuedFollowUps = new QueuedFollowUpAcceptanceRegistry({ now: () => 1_000 });
	const directSent: unknown[] = [];
	direct.pi.sendMessage = ((m: unknown, o: unknown) => directSent.push({ m, o })) as never;
	await handleSend({ type: "send", payload: { content: "direct" }, id: "d1" }, direct);
	assert.equal((direct.responses[0] as any).data.disposition, "direct");
	assert.equal(
		((directSent[0] as { m: { details: Record<string, unknown> } }).m.details).deliveryId,
		undefined,
	);
	assert.equal(direct.state.queuedFollowUps.pendingCount(), 0);

	const steered = handlerContext();
	steered.ctx.isIdle = () => false;
	steered.state.queuedFollowUps = new QueuedFollowUpAcceptanceRegistry({ now: () => 1_000 });
	const steeredSent: unknown[] = [];
	steered.pi.sendMessage = ((m: unknown, o: unknown) => steeredSent.push({ m, o })) as never;
	await handleSend({ type: "send", payload: { content: "steer" }, delivery: "immediate", id: "s1" }, steered);
	assert.equal((steered.responses[0] as any).data.disposition, "steered");
	assert.equal(
		((steeredSent[0] as { m: { details: Record<string, unknown> } }).m.details).deliveryId,
		undefined,
	);
	assert.equal(steered.state.queuedFollowUps.pendingCount(), 0);
});
