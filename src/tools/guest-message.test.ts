import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import { registerGuestMessagingTools, reconcileGuestMessagingTools } from "./guest-message.ts";

function runtime(status: "pending" | "approved" = "approved") {
	const guest = createGuestMembershipRuntime({
		guestIdentity: "guest-session",
		callbackEndpoint: "/tmp/guest.sock",
		createRequestId: () => "request-1",
		submitJoinRequest: async () => undefined,
	});
	guest.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Alex",
			memberSocket: "/tmp/alpha-member.sock",
			submittedByMember: "lead",
		},
		"request-1",
		status,
		status === "approved" ? "capability" : undefined,
	);
	return guest;
}

function harness() {
	const tools: Array<{ name: string; parameters: any; execute: (...args: any[]) => Promise<any> }> = [];
	const pi = {
		registerTool: (tool: any) => tools.push(tool),
		getActiveTools: () => ["read", "guest_send", "guest_broadcast"],
		setActiveTools: (active: string[]) => active,
	};
	const state = { guestMembershipRuntime: runtime() } as any;
	const capture: any[] = [];
	registerGuestMessagingTools(pi as any, state, {
		loadManifest: async () => ({
			crew: { id: "alpha", displayName: "Alpha" },
			members: [{ name: "lead", role: "lead", socketPath: "/tmp/lead.sock" }],
			approvedGuests: [
				{ guestIdentity: "guest-session", guestName: "Alex", callbackEndpoint: "/tmp/guest.sock" },
			],
		}),
		transport: {
			send: async (_endpoint: string, command: unknown) => {
				capture.push(command);
				return {
					response: {
						success: true,
						data: { deliveryId: "delivery-1", disposition: "direct", fromGuestName: "Alex" },
					},
				};
			},
		},
	});
	return { tools, state, capture, pi };
}

test("Guest tools expose exact crew-scoped send and broadcast parameters", () => {
	const { tools } = harness();
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["guest_send", "guest_broadcast"],
	);
	assert.deepEqual(Object.keys(tools[0]!.parameters.properties), ["crew", "target", "message", "instructions"]);
	assert.deepEqual(Object.keys(tools[1]!.parameters.properties), ["crew", "message", "instructions"]);
});

test("Guest send tool derives credentials from runtime and routes direct", async () => {
	const { tools, capture } = harness();
	const result = await tools[0]!.execute(
		"call-1",
		{ crew: "alpha", target: "lead", message: "hello" },
		new AbortController().signal,
	);
	assert.equal(result.isError, undefined);
	assert.equal(capture[0].guestIdentity, "guest-session");
	assert.equal(capture[0].capability, "capability");
	assert.equal(capture[0].target, "lead");
});

test("Guest tools stay inactive without an approved membership", () => {
	const state = { guestMembershipRuntime: runtime("pending") } as any;
	let active = ["read", "guest_send", "guest_broadcast"];
	const pi = { getActiveTools: () => active, setActiveTools: (next: string[]) => (active = next) } as any;
	reconcileGuestMessagingTools(pi, state);
	assert.deepEqual(active, ["read"]);
});
