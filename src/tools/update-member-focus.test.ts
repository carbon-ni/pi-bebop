import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUpdateMemberFocusTool } from "./update-member-focus.ts";
import { MEMBER_FOCUS_ENTRY_TYPE } from "../domain/index.ts";
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
	context: Partial<{
		isProjectTrusted: () => boolean;
		sessionManager: { getEntries: () => readonly unknown[] };
	}> = {},
) {
	let registeredTool: RegisteredTool | undefined;
	const entries: unknown[] = [];
	const appended: Array<{ customType: string; data?: unknown }> = [];
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
		appendEntry(customType: string, data?: unknown) {
			appended.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = {
		membershipRuntime: { getMembership },
		context: {
			isProjectTrusted: () => true,
			sessionManager: { getEntries: () => entries },
			...context,
		},
	} as never as SocketState;
	registerUpdateMemberFocusTool(pi, state);
	assert.ok(registeredTool);
	return { tool: registeredTool!, appended, entries };
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

describe("update_member_focus tool", () => {
	test("registers strict set|clear action, optional focus, and an honest self-reported description", () => {
		const { tool } = setup(membership);
		assert.equal(tool.name, "update_member_focus");
		const parameters = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.deepEqual(Object.keys(parameters).sort(), ["action", "focus"]);
		assert.match(tool.description, /self-reported|member-reported/);
		assert.match(tool.description, /set\|clear/);
		assert.match(tool.description, /secrets|credentials|sensitive/);
	});

	test("unjoined execution resolves to a not-joined error with no persistence", async () => {
		const { tool, appended } = setup(() => null);
		const result = await tool.execute("id", { action: "set", focus: "Working" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "not-joined");
		assert.equal(appended.length, 0);
	});

	test("set persists a typed entry scoped to canonical identity and reports the focus", async () => {
		const { tool, appended, entries } = setup(membership);
		const result = await tool.execute("id", { action: "set", focus: "Implementing Inbox enqueue" });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /member-reported/);
		assert.match(result.content[0]!.text, /Implementing Inbox enqueue/);
		assert.equal(appended[0]!.customType, MEMBER_FOCUS_ENTRY_TYPE);
		assert.equal(
			(appended[0]!.data as { memberIdentity?: string }).memberIdentity,
			"/project/.pi/bebop/sockets/Tony.sock",
		);
		assert.deepEqual((appended[0]!.data as { action?: string }).action, "set");
		assert.equal(entries.length, 1);
	});

	test("clear persists a typed clear entry and reports unspecified", async () => {
		const { tool, appended } = setup(membership);
		const result = await tool.execute("id", { action: "clear" });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /unspecified/);
		assert.deepEqual((appended[0]!.data as { action?: string }).action, "clear");
		assert.equal("focus" in (appended[0]!.data as Record<string, unknown>), false);
	});

	test("set rejects blank, padded, multiline, and oversized focus without persisting", async () => {
		const { tool, appended } = setup(membership);
		for (const focus of ["", "   ", "  padded  ", "line1\nline2", "x".repeat(300)]) {
			const result = await tool.execute("id", { action: "set", focus });
			assert.equal(result.isError, true, `expected error for ${JSON.stringify(focus)}`);
			assert.equal((result.details as { error?: string }).error, "invalid-focus");
		}
		assert.equal(appended.length, 0);
	});

	test("unknown action is a deterministic invalid-action error", async () => {
		const { tool, appended } = setup(membership);
		const result = await tool.execute("id", { action: "pause" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "invalid-action");
		assert.equal(appended.length, 0);
	});
});
