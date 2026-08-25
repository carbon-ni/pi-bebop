import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSocketState } from "../pi/control-runtime.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { YieldingWaitRegistry } from "../domain/index.ts";
import { YieldingWaitRuntime } from "../pi/wait-resume.ts";
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
	const delivered: Array<{ content: string; deliverAs: string }> = [];
	const yieldRuntime = new YieldingWaitRuntime({
		registry: new YieldingWaitRegistry(),
		deliver: (message) => delivered.push({ content: message.content, deliverAs: message.deliverAs }),
		isRunIdle: () => true,
		now: () => 1_000,
		createId: () => `wait-${delivered.length + 1}`,
	});
	return { tools, state, pi, yieldRuntime, delivered };
}

test("coordination tools are distinct from accepted-only follow-up vocabulary", () => {
	const { tools, state, pi, yieldRuntime } = setup();
	registerSendMemberRequestTool(pi, state);
	registerRespondToMemberRequestTool(pi, state);
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
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

test("TASK-0076: request tools make Requester/Responder roles structurally explicit", () => {
	const { tools, state, pi, yieldRuntime } = setup();
	registerSendMemberRequestTool(pi, state);
	registerRespondToMemberRequestTool(pi, state);
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
	const send = tools.get("send_member_request")!.description;
	const respond = tools.get("respond_to_member_request")!.description;
	const wait = tools.get("wait_for_request_outcome")!.description;
	// Requester-side send: recommended for any message whose sender requires one answer/report/verdict/evidence.
	assert.match(send, /requester-side/i);
	assert.match(send, /one answer, report, verdict, or evidence response/i);
	// Responder-side respond: only for an inbound Member request.
	assert.match(respond, /responder-side/i);
	assert.match(respond, /inbound Member request/i);
	assert.doesNotMatch(respond, /requester|wait_for_request_outcome/);
	// Requester-only wait: call only after the current member sent a Member request; never inbound handling.
	assert.match(wait, /requester-side/i);
	assert.match(wait, /only after you sent a Member request/i);
	assert.match(wait, /never handles inbound/i);
});

test("TASK-0076: empty wait fails with no-pending-member-requests and self-correcting recovery guidance", async () => {
	const { tools, state, pi, yieldRuntime } = setup();
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "no-pending-member-requests");
	assert.match(String(result.content[0]?.text ?? ""), /respond_to_member_request|send a new|continue/);
});

test("TASK-0077: abort cancels the parked wait and never resumes; request state survives", async () => {
	const { tools, state, pi, yieldRuntime, delivered } = setup();
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
	state.memberRequestFlow!.registry.registerOutbound({
		requestId: "active",
		member: { name: "qa", role: "reviewer" },
		now: 1_000,
	});
	const controller = new AbortController();
	const pending = tools.get("wait_for_request_outcome")!.execute("id", {}, controller.signal);
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, undefined, "yielded result, not an abort error");
	assert.equal(result.details.yielded, true);
	assert.equal(state.memberRequestFlow!.registry.outboundCount(), 1, "request state preserved");
	assert.equal(delivered.length, 0, "aborted wait must never resume");
});

test("empty wait fails immediately and never starts a polling loop", async () => {
	const { tools, state, pi, yieldRuntime } = setup();
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "no-pending-member-requests");
});

test("TASK-0080: buffered post-idle grace timeout resumes once via the runtime, never twice", async () => {
	const { tools, state, pi, yieldRuntime, delivered } = setup();
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
	const registry = state.memberRequestFlow!.registry;
	registry.registerOutbound({ requestId: "idle-1", member: { name: "qa", role: "reviewer" }, now: 1_000 });
	registry.acceptOutbound("idle-1");
	registry.armOutboundIdle("idle-1");
	registry.resolveTimeout("idle-1", "response-after-idle"); // buffered before the wait parks
	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.yielded, true, "tool yields immediately");
	assert.equal(delivered.length, 1, "buffered outcome resumes exactly once");
	assert.match(delivered[0]!.content, /timeout:response-after-idle/);
	assert.equal(delivered[0]!.deliverAs, "steer");
	assert.equal(registry.outboundCount(), 0);
});
