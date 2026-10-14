import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	memberDeliveryOutputSchema,
	projectGuestBroadcastDetails,
	projectGuestMessageDetails,
	projectMemberDeliveryDetails,
	registerBebopTool,
} from "./codemode-tool.ts";

test("codemode DTOs exclude member endpoints and Guest callback identity", () => {
	const member = projectMemberDeliveryDetails({
		member: { kind: "member", name: "qa", role: "reviewer", socketPath: "/private/qa.sock" },
		deliveryId: "delivery-1",
		disposition: "queued",
	});
	assert.deepEqual(member, {
		member: { name: "qa", role: "reviewer" },
		deliveryId: "delivery-1",
		disposition: "queued",
	});
	assert.equal("socketPath" in member, false);

	const guest = projectGuestMessageDetails({
		target: { name: "guest", role: "observer" },
		guestIdentity: "secret-guest-id",
		callbackEndpoint: "http://127.0.0.1:9000/callback",
		deliveryId: "delivery-2",
		disposition: "direct",
		fromGuestName: "alice",
	});
	assert.deepEqual(guest, {
		target: { name: "guest", role: "observer" },
		deliveryId: "delivery-2",
		disposition: "direct",
		fromGuestName: "alice",
	});
	assert.equal("guestIdentity" in guest, false);
	assert.equal("callbackEndpoint" in guest, false);
});

test("Guest broadcast DTO keeps delivery facts without remote endpoint data", () => {
	assert.deepEqual(
		projectGuestBroadcastDetails({
			summary: { delivered: 1, failed: 1, total: 2 },
			dispositions: [
				{
					recipientName: "qa",
					recipientRole: "reviewer",
					disposition: "delivered",
					deliveryId: "delivery-3",
					callbackEndpoint: "http://127.0.0.1:9001/callback",
				},
			],
		}),
		{
			summary: { delivered: 1, failed: 1, total: 2 },
			recipients: [{ member: "qa", role: "reviewer", disposition: "delivered", deliveryId: "delivery-3" }],
		},
	);
});

test("registered codemode calls preserve semantic results and AbortSignal", async () => {
	let registered: any;
	const pi = { registerTool: (tool: unknown) => (registered = tool) } as unknown as ExtensionAPI;
	let receivedSignal: AbortSignal | undefined;
	registerBebopTool(
		pi,
		{
			name: "fixture",
			label: "Fixture",
			description: "fixture",
			parameters: {} as never,
			execute: async (_id, _params, signal) => {
				receivedSignal = signal;
				return {
					content: [{ type: "text", text: "prose" }],
					details: {
						member: { name: "qa", role: "reviewer", socketPath: "/private" },
						deliveryId: "delivery",
						disposition: "queued",
					},
				};
			},
		},
		{
			outputSchema: memberDeliveryOutputSchema,
			projectDetails: projectMemberDeliveryDetails,
		},
	);
	const controller = new AbortController();
	const result = await registered.execute("id", {}, controller.signal);
	assert.equal(receivedSignal, controller.signal);
	assert.deepEqual(result.structuredContent, {
		member: { name: "qa", role: "reviewer" },
		deliveryId: "delivery",
		disposition: "queued",
	});
	assert.equal("socketPath" in result.structuredContent.member, false);
	assert.equal(result.content[0].text, "prose");
	assert.equal(registered.outputSchema !== undefined, true);
	assert.equal(registered.executionMode, "parallel");
});
