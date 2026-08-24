import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSocketState } from "../pi/control-runtime.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";
import { registerSendFollowUpTool } from "./send-follow-up.ts";

type Tool = { name: string; description: string; execute: (...args: any[]) => Promise<any> };

function setup() {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool: (tool: unknown) => tools.set((tool as Tool).name, tool as Tool),
	} as unknown as ExtensionAPI;
	const state = createSocketState();
	const dependencies = {
		transport: { send: async () => ({ ok: true }) as never },
		resolveEndpoint: async (socketPath: string) => socketPath,
		coordinator: createMemberMessageCoordinator(),
	};
	registerSendFollowUpTool(pi, state, dependencies);
	return { tools, state, pi };
}

test("TASK-0076: send_follow_up is information-only and no longer advertises itself as default", () => {
	const { tools } = setup();
	const description = tools.get("send_follow_up")!.description;
	// The default-coordination contradiction is gone.
	assert.doesNotMatch(description, /by default|default coordination/i);
	// Information-only; no correlated Response expected.
	assert.match(description, /information/i);
	assert.match(description, /no correlated Response/i);
	// Assignments/questions requiring one report are directed to the request tool.
	assert.match(description, /send_member_request/i);
	assert.match(description, /answer|report|verdict|evidence|response/i);
});
