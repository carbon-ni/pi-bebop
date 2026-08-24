import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSocketState } from "../pi/control-runtime.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import {
	registerSendMemberRequestTool,
	registerRespondToMemberRequestTool,
	registerWaitForRequestOutcomeTool,
} from "./member-request.ts";

type Tool = { name: string; description: string; execute: (...args: any[]) => Promise<any> };
function setup() {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool: (tool: unknown) => tools.set((tool as Tool).name, tool as Tool),
	} as unknown as ExtensionAPI;
	const state = createSocketState();
	state.memberRequestFlow = new MemberRequestFlow({
		resolveEndpoint: async (path) => path,
		createRequestId: () => "request-1",
		setTimeout: (() => undefined) as any,
		clearTimeout: (() => undefined) as any,
		transport: {
			open: async (_endpoint, _command, _options) => ({ close: () => undefined }),
			respond: async () => undefined,
		},
	});
	return { tools, state, pi };
}

test("coordination tools are distinct from accepted-only follow-up vocabulary", () => {
	const { tools, state, pi } = setup();
	registerSendMemberRequestTool(pi, state);
	registerRespondToMemberRequestTool(pi, state);
	registerWaitForRequestOutcomeTool(pi, state);
	assert.deepEqual(
		[...tools.keys()],
		["send_member_request", "respond_to_member_request", "wait_for_request_outcome"],
	);
	assert.match(tools.get("send_member_request")!.description, /requiring.*response/i);
	assert.match(tools.get("send_member_request")!.description, /send_follow_up/i);
	assert.match(tools.get("respond_to_member_request")!.description, /correlated/i);
	assert.equal(tools.get("send_member_request")!.label, "Send Member Request");
	assert.equal(tools.get("respond_to_member_request")!.label, "Respond to Member Request");
	assert.equal(tools.get("wait_for_request_outcome")!.label, "Wait for Request Outcome");
	assert.match(tools.get("wait_for_request_outcome")!.description, /oldest terminal outbound Request outcome/i);
	assert.match(tools.get("wait_for_request_outcome")!.description, /does not poll/i);
	assert.equal(
		[...tools.keys()].some(
			(name) => name === ["request", "member"].join("_") || name === ["wait", "for", "crew", "update"].join("_"),
		),
		false,
	);
});

test("wait cancellation releases only the waiter and preserves active request state", async () => {
	const { tools, state, pi } = setup();
	registerWaitForRequestOutcomeTool(pi, state);
	state.memberRequestFlow!.registry.registerOutbound({
		requestId: "active",
		member: { name: "qa", role: "reviewer" },
		now: 1_000,
	});
	const controller = new AbortController();
	const pending = tools.get("wait_for_request_outcome")!.execute("id", {}, controller.signal);
	controller.abort();
	const result = await pending;
	assert.equal(result.details.error, "aborted");
	assert.equal(state.memberRequestFlow!.registry.outboundCount(), 1);
});

test("empty wait fails immediately and never starts a polling loop", async () => {
	const { tools, state, pi } = setup();
	registerWaitForRequestOutcomeTool(pi, state);
	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "no-pending-member-requests");
});
