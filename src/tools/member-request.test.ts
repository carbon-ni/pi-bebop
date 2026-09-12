import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSocketState } from "../pi/control-runtime.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { RequestOutcomeRegistry } from "../domain/index.ts";
import { registerWaitForRequestOutcomeTool } from "./member-request.ts";

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
	registerWaitForRequestOutcomeTool(pi, state);
	return { tools, state, pi };
}

function registerAccepted(state: ReturnType<typeof createSocketState>, requestId = "active") {
	const registry = state.memberRequestFlow!.registry;
	registry.registerOutbound({ requestId, member: { name: "qa", role: "reviewer" }, now: 1_000 });
	registry.acceptOutbound(requestId);
	return registry;
}

test("request outcome waiting is blocking and distinct from accepted-only follow-up vocabulary", () => {
	const { tools } = setup();
	const wait = tools.get("wait_for_request_outcome")!;
	assert.equal(wait.label, "Wait for Request Outcome");
	assert.match(wait.description, /oldest terminal outbound Request outcome/i);
	assert.match(wait.description, /block this tool call/i);
	assert.match(wait.description, /bounded wait is cancellable/i);
	assert.match(wait.description, /accepted inbound Bebop message releases/i);
	assert.doesNotMatch(wait.description, /crew-wait-resume|yields the run/i);
});

test("TASK-0151: empty wait succeeds as all-settled without blocking", async () => {
	const { tools } = setup();
	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, undefined);
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.details, { pending_count: 0 });
	assert.match(String(result.content[0]?.text ?? ""), /all.*settled/i);
});

test("TASK-0151: wait blocks the same tool call until a terminal Response arrives", async () => {
	const { tools, state } = setup();
	const registry = registerAccepted(state);
	let settled = false;
	const pending = tools
		.get("wait_for_request_outcome")!
		.execute("id", {}, new AbortController().signal)
		.then((result) => {
			settled = true;
			return result;
		});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "the wait remains blocked while the request is active");
	registry.resolveResponse({
		requestId: "active",
		member: { name: "qa", role: "reviewer" },
		message: "Evidence attached: 3 findings",
		instructions: ["review finding 1", "confirm gate"],
	});
	const result = await pending;
	assert.equal(result.isError, undefined);
	assert.equal(result.terminate, undefined);
	assert.equal(result.details.result.kind, "response");
	assert.equal(state.wakeGate.armed, false, "terminal outcome releases the shared message wake gate");
	assert.match(String(result.content[0]?.text ?? ""), /Evidence attached: 3 findings/);
	assert.match(String(result.content[0]?.text ?? ""), /1\. review finding 1/);
	assert.match(String(result.content[0]?.text ?? ""), /2\. confirm gate/);
	assert.equal(registry.outboundCount(), 0);
});

test("accepted inbound messages release the Request outcome wait without settling the outbound request", async () => {
	const { tools, state } = setup();
	const registry = registerAccepted(state);
	const pending = tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(state.wakeGate.armed, true, "the Request outcome wait arms the shared message wake gate");
	assert.equal(state.wakeGate.notifyAccepted("delivery-1"), true);

	const result = await pending;
	assert.equal(result.isError, undefined);
	assert.equal(result.terminate, true, "the message wake skips the content-free continuation");
	assert.deepEqual(result.details, { outcome: "message-received" });
	assert.equal(registry.outboundCount(), 1, "message wake does not settle the outbound request");
	assert.equal(state.wakeGate.armed, false, "the consumed wake listener is cleaned up");

	registry.resolveResponse({
		requestId: "active",
		member: { name: "qa", role: "reviewer" },
		message: "The later response",
		instructions: [],
	});
	const later = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(later.details.result.message, "The later response");
});

test("an existing blocking wait rejects a Request outcome waiter without leaving registry state armed", async () => {
	const { tools, state } = setup();
	const registry = registerAccepted(state);
	const listener = () => undefined;
	assert.deepEqual(state.wakeGate.arm(listener), { ok: true });

	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "wait-in-progress");
	assert.equal(registry.outboundCount(), 1);
	state.wakeGate.release(listener);
	assert.equal(state.wakeGate.armed, false);
});

test("TASK-0151: terminal outcomes resolve the blocked call with actionable recovery", async () => {
	const cases = [
		{
			requestId: "offline",
			resolve: (registry: RequestOutcomeRegistry) => registry.resolveOffline("offline"),
			phrases: ["offline", "reassign", "send_to_inbox"],
		},
		{
			requestId: "idle-timeout",
			resolve: (registry: RequestOutcomeRegistry) => {
				registry.armOutboundIdle("idle-timeout");
				return registry.resolveTimeout("idle-timeout", "response-after-idle");
			},
			phrases: ["settled without a Response", "send a new send_member_request"],
		},
		{
			requestId: "hard-timeout",
			resolve: (registry: RequestOutcomeRegistry) => registry.resolveTimeout("hard-timeout", "max-wait"),
			phrases: ["safety deadline", "Member Status", "send_to_inbox", "redirect_member"],
		},
	] as const;
	for (const scenario of cases) {
		const { tools, state } = setup();
		const registry = registerAccepted(state, scenario.requestId);
		const pending = tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
		await new Promise((resolve) => setImmediate(resolve));
		scenario.resolve(registry);
		const result = await pending;
		assert.equal(result.details.result.requestId, scenario.requestId);
		const text = String(result.content[0]?.text ?? "");
		for (const phrase of scenario.phrases) assert.match(text, new RegExp(phrase, "i"));
	}
});

test("TASK-0151: buffered terminal outcome resolves immediately in FIFO order", async () => {
	const { tools, state } = setup();
	const registry = state.memberRequestFlow!.registry;
	registerAccepted(state, "first");
	registerAccepted(state, "second");
	registry.resolveOffline("first");
	registry.resolveOffline("second");
	const first = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	const second = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(first.details.result.requestId, "first");
	assert.equal(second.details.result.requestId, "second");
});

test("TASK-0151: abort releases the blocked waiter without changing request state", async () => {
	const { tools, state } = setup();
	const registry = registerAccepted(state);
	const controller = new AbortController();
	const pending = tools.get("wait_for_request_outcome")!.execute("id", {}, controller.signal);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "aborted");
	assert.equal(state.wakeGate.armed, false, "abort releases the shared message wake gate");
	assert.equal(result.terminate, undefined);
	assert.equal(registry.outboundCount(), 1);
	const released = registry.waitForUpdate(() => undefined);
	assert.equal(released.ok, true);
	if (released.ok && released.kind === "waiting") released.cancel();
});

test("TASK-0151: only one blocked waiter is allowed", async () => {
	const { tools, state } = setup();
	const registry = registerAccepted(state);
	const first = tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	await new Promise((resolve) => setImmediate(resolve));
	const second = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(second.isError, true);
	assert.equal(second.details.error, "already-waiting");
	registry.resolveOffline("active");
	const result = await first;
	assert.equal(result.details.result.kind, "offline");
});

test("TASK-0151: missing flow is actionable and nonblocking", async () => {
	const { tools, state } = setup();
	state.memberRequestFlow = undefined;
	const result = await tools.get("wait_for_request_outcome")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "wait-failed");
});
