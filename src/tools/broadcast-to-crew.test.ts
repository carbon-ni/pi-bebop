import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBroadcastPartialError,
	normalizeBroadcastErrorCode,
	registerBroadcastToCrewTool,
} from "./broadcast-to-crew.ts";
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
	notifyRecipient?: (recipient: unknown) => Promise<void>,
	sendHint?: (...args: any[]) => Promise<unknown>,
): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = { membershipRuntime: { getMembership } } as never as SocketState;
	if (openStoreImpl || notifyRecipient || sendHint)
		state.broadcastStoreDependencies = {
			isProjectTrusted: () => true,
			openStore: openStoreImpl as never,
			notifyRecipient,
		} as never;
	registerBroadcastToCrewTool(pi, state, {
		isProjectTrusted: () => true,
		// @ts-expect-error partial store for registration contract test
		openStore: openStoreImpl,
		sendHint: sendHint as never,
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
	test("public tool persists before notifying each recipient and retains writes on hint failure", async () => {
		const order: string[] = [];
		const store = {
			enqueueWithId: async (_payload: unknown, _now: number, id: string) => {
				order.push(`persist:${id}`);
				return { item: { id } };
			},
			peekOldest: async () => null,
			list: async () => [],
			count: async () => 0,
			remove: async () => ({ removed: true }),
			cancel: async () => ({ removed: true }),
		} as never;
		const tool = setup(
			membership,
			async () => store,
			undefined,
			async (endpoint: string, command: any, options: any) => {
				order.push(`hint:${command.payload.origin.name}`);
				assert.equal(endpoint, "/project/.pi/bebop/sockets/Bob.sock");
				assert.equal(options.timeout, 1000);
				assert.equal(command.type, "send");
				assert.equal(command.delivery, "follow_up");
				assert.equal(
					command.payload.content,
					"[inbox] You have a new durable inbox item. Check your inbox when available.",
				);
				assert.deepEqual(command.payload.instructions, ["Check your crew inbox for pending items"]);
				assert.deepEqual(command.payload.origin, { kind: "crew", name: "Tony", role: "lead" });
				throw new Error("offline");
			},
		);
		const result = await tool.execute("call", { message: "hello" });
		assert.equal((result.details as { persisted: number }).persisted, 1);
		assert.deepEqual(order, ["persist:broadcast-4cabbbef-ebcba174", "hint:Tony"]);
	});

	test("partial failure uses canonical envelope and keeps summary structured", () => {
		const result = createBroadcastPartialError({
			broadcastId: "b-1",
			total: 2,
			persisted: 1,
			failed: 1,
			recipients: [{ member: "Bob", error: "raw /tmp/private.sock" }],
		});
		assert.equal(result.content[0]?.text, result.details.actionableError.message);
		assert.equal(result.details.error, "broadcast-partial-failure");
		assert.equal(result.details.broadcastId, "b-1");
		assert.equal("recipients" in result.details, false);
		assert.equal(JSON.stringify(result.details).includes("private.sock"), false);
		const unsafe = createBroadcastPartialError({ broadcastId: "/tmp/private.sock" });
		assert.equal(unsafe.details.broadcastId, undefined);
		for (const code of ["not-joined", "unknown-sender", "invalid-request", "untrusted-project"]) {
			assert.equal(normalizeBroadcastErrorCode(code), code);
		}
		assert.equal(normalizeBroadcastErrorCode("password-secret"), "unexpected-failure");
	});
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
		assert.equal((details as any).actionableError.code, details.error);
		assert.equal(result.content[0]?.text, (details as any).actionableError.message);
		assert.doesNotMatch(JSON.stringify(result.details), /must not open store|Error:/i);
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
		const details = result.details as { error: string; actionableError: { code: string; message: string } };
		assert.equal(details.actionableError.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError.message);
	});
});
