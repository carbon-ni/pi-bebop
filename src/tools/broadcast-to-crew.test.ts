import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBroadcastToCrewTool } from "./broadcast-to-crew.ts";
import type { SocketState } from "../pi/control-runtime.ts";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
	}>;
};

function setup(
	membership: unknown | (() => unknown),
	openStoreImpl: (() => Promise<unknown>) | undefined = undefined,
): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = { membershipRuntime: { getMembership } } as never as SocketState;
	registerBroadcastToCrewTool(pi, state, {
		isProjectTrusted: () => true,
		// @ts-expect-error partial store for registration contract test
		openStore: openStoreImpl,
	});
	assert.ok(registeredTool);
	return registeredTool!;
}

const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	member: {
		name: "Tony",
		role: "lead",
		socket: "sockets/Tony.sock",
		socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	},
	manifest: {
		version: 1,
		presence: { notifications: true },
		members: [
			{
				name: "Tony",
				role: "lead",
				socket: "sockets/Tony.sock",
				socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			},
			{
				name: "Bob",
				role: "dev",
				socket: "sockets/Bob.sock",
				socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			},
		],
	},
};

describe("broadcast_to_crew tool", () => {
	test("registers with only message and instructions and a teaching description", () => {
		const tool = setup(membership);
		assert.equal(tool.name, "broadcast_to_crew");
		const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(properties.sort(), ["instructions", "message"]);
		assert.match(tool.description, /every other configured crew member/);
		assert.match(tool.description, /send_follow_up|send_to_inbox/);
		assert.match(tool.description, /never/);
	});

	test("unjoined execution resolves to a not-joined error without touching the store", async () => {
		let opened = false;
		const tool = setup(
			() => null,
			() => {
				opened = true;
				return Promise.reject(new Error("must not open store when not joined"));
			},
		);
		const result = await tool.execute("id", { message: "hello" });
		assert.equal(result.isError, true);
		assert.equal(opened, false);
		const details = result.details as { error?: string };
		assert.ok(details.error);
	});

	test("single-member crew returns no-recipients without storage IO", async () => {
		const solo = {
			...membership,
			manifest: { ...membership.manifest, members: [membership.manifest.members[0]!] },
		};
		let opened = false;
		const tool = setup(solo, async () => {
			opened = true;
			return {};
		});
		const result = await tool.execute("id", { message: "hi" });
		assert.equal(result.isError, true);
		assert.equal(opened, false, "no store should be opened for a single-member crew");
	});
});
