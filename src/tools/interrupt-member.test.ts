import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BebopClientError, type MemberInterruptOperation } from "../sdk/index.ts";
import { registerInterruptMemberTool } from "./interrupt-member.ts";

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

function setup(interruptMember: MemberInterruptOperation["interruptMember"]): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	registerInterruptMemberTool(pi, { interruptMember });
	assert.ok(registeredTool);
	return registeredTool!;
}

const success = {
	member: { name: "Bob", role: "dev" },
	interruptId: "interrupt-1",
	disposition: "interrupt-requested" as const,
};

describe("interrupt_member tool", () => {
	test("registers only the recovery inputs and describes best-effort semantics", () => {
		const tool = setup(async () => success);
		assert.equal(tool.name, "interrupt_member");
		const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(properties.sort(), ["instructions", "member", "message"]);
		assert.match(tool.description, /stuck|harmful|invalid assumptions/);
		assert.match(tool.description, /redirect_member|send_follow_up/);
		assert.match(tool.description, /never rolls back/);
	});

	test("delegates exact recovery input and reports the actual disposition", async () => {
		const calls: unknown[] = [];
		const tool = setup(async (...args) => {
			calls.push(args);
			return success;
		});
		const result = await tool.execute("id", {
			member: " Bob ",
			message: "stop now",
			instructions: ["preserve logs", "report blockers"],
		});
		assert.deepEqual(calls, [["Bob", { message: "stop now", instructions: ["preserve logs", "report blockers"] }]]);
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /abort requested best-effort/);
		assert.deepEqual(result.details, { interruptId: "interrupt-1", disposition: "interrupt-requested" });
	});

	test("maps SDK authority and malformed-response failures to tool errors", async () => {
		for (const code of ["not-joined", "untrusted", "unknown-member", "malformed-response"] as const) {
			const tool = setup(async () => {
				throw new BebopClientError(code);
			});
			const result = await tool.execute("id", { member: "Bob", message: "stop" });
			assert.equal(result.isError, true);
			assert.deepEqual(result.details, { error: code });
		}
	});

	test("does not expose raw transport details", async () => {
		const tool = setup(async () => {
			throw new Error("socket path /private/path was reset");
		});
		const result = await tool.execute("id", { member: "Bob", message: "stop" });
		assert.equal(result.isError, true);
		assert.deepEqual(result.details, { error: "transport-error" });
		assert.doesNotMatch(result.content[0]!.text, /private\/path/);
	});
});
