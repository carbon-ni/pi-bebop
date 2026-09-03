import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBroadcastToCrewTool } from "./broadcast-to-crew.ts";
import { createMemberMessageCoordinator, type MemberMessageDependencies } from "../application/member-message.ts";
import type { SocketState } from "../pi/control-runtime.ts";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
	}>;
};

const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: "/project/tony.sock",
	member: { name: "Tony", role: "lead", socketPath: "/project/tony.sock" },
	manifest: {
		members: [
			{ name: "Tony", role: "lead", socketPath: "/project/tony.sock" },
			{ name: "Bob", role: "dev", socketPath: "/project/bob.sock" },
			{ name: "Kelly", role: "qa", socketPath: "/project/kelly.sock" },
		],
	},
};
function setup(currentMembership: unknown | (() => unknown), dependencies: MemberMessageDependencies): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool: (tool: unknown) => (registeredTool = tool as RegisteredTool),
	} as unknown as ExtensionAPI;
	const state = {
		membershipRuntime: {
			getMembership: typeof currentMembership === "function" ? currentMembership : () => currentMembership,
		},
	} as never as SocketState;
	registerBroadcastToCrewTool(pi, state, dependencies);
	assert.ok(registeredTool);
	return registeredTool!;
}
function deps(calls: string[]): MemberMessageDependencies {
	return {
		resolveEndpoint: async (socketPath) => socketPath,
		coordinator: createMemberMessageCoordinator(),
		transport: {
			send: async (endpoint, command) => {
				calls.push(`${endpoint}:${String((command.payload as { kind: string }).kind)}:${command.delivery}`);
				return {
					response: {
						success: true,
						data: { deliveryId: `delivery-${calls.length}`, disposition: "queued" },
					} as never,
				};
			},
		},
	};
}

describe("broadcast_to_crew tool", () => {
	test("accepts only message and instructions and teaches transient Follow-up semantics", () => {
		const tool = setup(membership, deps([]));
		assert.equal(tool.name, "broadcast_to_crew");
		const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(properties.sort(), ["instructions", "message"]);
		assert.match(tool.description, /transient/);
		assert.match(tool.description, /every other configured crew member/);
		assert.match(tool.description, /never writes or falls back to Inbox/);
	});

	test("fans out and reports delivered recipients", async () => {
		const calls: string[] = [];
		const result = await setup(membership, deps(calls)).execute("id", { message: "hello", instructions: ["one"] });
		assert.equal(result.isError, false);
		assert.match(result.content[0]!.text, /Delivered to 2 recipients/);
		assert.deepEqual(calls, ["/project/bob.sock:broadcast:follow_up", "/project/kelly.sock:broadcast:follow_up"]);
		assert.deepEqual(result.details, {
			delivered: 2,
			failed: 0,
			total: 2,
			recipients: [
				{ member: "Bob", role: "dev", disposition: "delivered", deliveryId: "delivery-1" },
				{ member: "Kelly", role: "qa", disposition: "delivered", deliveryId: "delivery-2" },
			],
		});
	});

	test("unjoined execution fails without any transport", async () => {
		const calls: string[] = [];
		const result = await setup(() => null, deps(calls)).execute("id", { message: "hello" });
		assert.equal(result.isError, true);
		assert.equal(calls.length, 0);
	});
});
