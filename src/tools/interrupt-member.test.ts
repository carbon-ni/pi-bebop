import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeInterruptErrorCode, registerInterruptMemberTool } from "./interrupt-member.ts";
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

function setup(membership: unknown | (() => unknown)): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = { membershipRuntime: { getMembership } } as never as SocketState;
	registerInterruptMemberTool(pi, state);
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

describe("interrupt_member tool", () => {
	test("normalizes remote error codes through the closed vocabulary", () => {
		for (const code of ["already-pending", "abort-failed", "no-context", "handoff-failed", "outcome-unknown"]) {
			assert.equal(normalizeInterruptErrorCode(code), code);
		}
		assert.equal(normalizeInterruptErrorCode("offline"), "offline");
		assert.equal(normalizeInterruptErrorCode("password-secret"), "unexpected-failure");
		assert.equal(normalizeInterruptErrorCode("remote-error: /tmp/private.sock"), "unexpected-failure");
	});
	test("registers with only member, message, and instructions plus an honest description", () => {
		const tool = setup(membership);
		assert.equal(tool.name, "interrupt_member");
		const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(properties.sort(), ["instructions", "member", "message"]);
		assert.match(tool.description, /stuck|harmful|invalid assumptions/);
		assert.match(tool.description, /redirect_member|send_follow_up/);
		assert.match(tool.description, /never rolls back/);
	});

	test("unjoined execution resolves to a not-joined error", async () => {
		const tool = setup(() => null);
		const result = await tool.execute("id", { member: "Bob", message: "stop" });
		assert.equal(result.isError, true);
		const details = result.details as { error?: string; actionableError?: { code: string; message: string } };
		assert.equal(details.error, "not-joined");
		assert.equal(details.actionableError?.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError?.message);
	});

	test("unknown member resolves to an error", async () => {
		const tool = setup(membership);
		const result = await tool.execute("id", { member: "nobody", message: "stop" });
		assert.equal(result.isError, true);
		const details = result.details as { error?: string; actionableError?: { code: string; message: string } };
		assert.equal(details.error, "unknown-member");
		assert.equal(details.actionableError?.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError?.message);
	});

	test("self-interrupt is rejected", async () => {
		const tool = setup(membership);
		const result = await tool.execute("id", { member: "Tony", message: "stop" });
		assert.equal(result.isError, true);
		const details = result.details as { error?: string; actionableError?: { code: string; message: string } };
		assert.equal(details.error, "self-send");
		assert.equal(details.actionableError?.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError?.message);
	});
});
