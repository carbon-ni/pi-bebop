import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { parseCrewManifest } from "../domain/index.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import type { RpcClientOptions } from "../infra/rpc-client.ts";
import { createSocketState } from "../pi/control-runtime.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";
import { registerSendFollowUpTool } from "./send-follow-up.ts";
import { registerSendImmediateTool } from "./send-immediate.ts";

type Tool = {
	name: string;
	description: string;
	parameters: { properties?: Record<string, unknown> };
	execute: (...args: any[]) => Promise<any>;
};
const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
			{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
		],
	},
	"/project/.pi/bebop/crew.json",
);
const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest,
	member: { ...manifest.members[0], socketPath: "/project/.pi/bebop/sockets/dev.sock" },
	socketPath: "/project/.pi/bebop/sockets/dev.sock",
	globalSocketPath: "/project/global.sock",
};
function setup(
	sendRpcCommand: (path: string, command: any, options?: RpcClientOptions) => Promise<any>,
	joined = true,
	currentMembership = membership,
	dependencies = { coordinator: createMemberMessageCoordinator() },
): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool(tool: unknown) {
			const value = tool as Tool;
			tools.set(value.name, value);
		},
	} as unknown as ExtensionAPI;
	const state = createSocketState();
	state.context = { sessionManager: { getSessionId: () => "dev-session", getSessionName: () => "dev" } } as never;
	state.membershipRuntime = {
		getMembership: () => (joined ? currentMembership : null),
	} as unknown as MembershipRuntime;
	registerSendFollowUpTool(pi, state, { sendRpcCommand, ...dependencies });
	registerSendImmediateTool(pi, state, { sendRpcCommand, ...dependencies });
	return tools;
}
const ack = (disposition: string) => ({
	response: {
		type: "response",
		command: "send",
		success: true,
		id: "request-1",
		data: { deliveryId: "delivery-request-1", disposition },
	},
});

test("registers only intent-named tools with compact parameters and teaching descriptions", () => {
	const tools = setup(async () => ack("queued"));
	assert.deepEqual([...tools.keys()], ["send_follow_up", "send_immediate"]);
	for (const tool of tools.values()) {
		assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["member", "message", "wait_for"]);
		assert.equal(tool.description.includes("mode"), false);
		assert.equal(Value.Check(tool.parameters, { member: "qa", message: "x" }), true);
		assert.equal(Value.Check(tool.parameters, { member: "qa", message: "x", mode: "steer" }), false);
		assert.equal(Value.Check(tool.parameters, { member: "qa", message: "x", extra: true }), false);
	}
	assert.match(tools.get("send_follow_up")!.description, /default/i);
	assert.match(tools.get("send_immediate")!.description, /redirect.*active/i);
});

test("uses follow-up by default and maps immediate to explicit steering", async () => {
	const calls: any[] = [];
	const tools = setup(async (path, command, options) => {
		calls.push({ path, command, options });
		return ack(calls.length === 1 ? "queued" : "steered");
	});
	const follow = await tools
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "later" }, undefined, undefined, undefined);
	const immediate = await tools
		.get("send_immediate")!
		.execute("call", { member: "qa", message: "now" }, undefined, undefined, undefined);
	assert.equal(follow.isError, undefined);
	assert.equal(immediate.isError, undefined);
	assert.equal(calls[0].command.mode, "follow_up");
	assert.equal(calls[1].command.mode, "steer");
	assert.deepEqual(
		calls.map((call) => call.options),
		[{ signal: undefined }, { signal: undefined }],
	);
});

test("proves FIFO follow-ups wait for the first ack and immediates start concurrently", async () => {
	const order: string[] = [];
	let releaseFirst!: () => void;
	let releaseImmediate!: () => void;
	const firstReleased = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const immediateReleased = new Promise<void>((resolve) => {
		releaseImmediate = resolve;
	});
	let secondStarted = false;
	let immediateStarts = 0;
	let resolveImmediateStarts!: () => void;
	const immediateStarted = new Promise<void>((resolve) => {
		resolveImmediateStarts = resolve;
	});
	const tools = setup(async (_path, command) => {
		const message = command.message.split("\n")[0];
		order.push(message);
		if (message === "first follow-up") return firstReleased.then(() => ack("queued"));
		if (message === "second follow-up") {
			secondStarted = true;
			return ack("queued");
		}
		immediateStarts += 1;
		if (immediateStarts === 2) resolveImmediateStarts();
		return immediateReleased.then(() => ack("steered"));
	});
	const first = tools
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "first follow-up" }, undefined, undefined, undefined);
	const second = tools
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "second follow-up" }, undefined, undefined, undefined);
	await Promise.resolve();
	assert.equal(secondStarted, false);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order.slice(0, 2), ["first follow-up", "second follow-up"]);
	const immediateOne = tools
		.get("send_immediate")!
		.execute("call", { member: "qa", message: "redirect one" }, undefined, undefined, undefined);
	const immediateTwo = tools
		.get("send_immediate")!
		.execute("call", { member: "qa", message: "redirect two" }, undefined, undefined, undefined);
	await immediateStarted;
	assert.equal(immediateStarts, 2);
	releaseImmediate();
	await Promise.all([immediateOne, immediateTwo]);
});

test("rejects ambiguous roles before RPC and aborts queued follow-ups before delivery", async () => {
	const ambiguousManifest = parseCrewManifest(
		{
			version: 1,
			members: [
				{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
				{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
				{ name: "qa2", role: "reviewer", socket: "sockets/qa2.sock" },
			],
		},
		"/project/.pi/bebop/crew.json",
	);
	let calls = 0;
	const tools = setup(
		async () => {
			calls += 1;
			return ack("queued");
		},
		true,
		{ ...membership, manifest: ambiguousManifest },
	);
	const ambiguous = await tools
		.get("send_follow_up")!
		.execute("call", { member: "reviewer", message: "x" }, undefined, undefined, undefined);
	assert.equal(ambiguous.isError, true);
	assert.match(ambiguous.content[0].text, /Ambiguous/);
	assert.equal(calls, 0);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = setup(async () => {
		calls += 1;
		await gate;
		return ack("queued");
	});
	const firstPending = first
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "first" }, undefined, undefined, undefined);
	const controller = new AbortController();
	const secondPending = first
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "second" }, controller.signal, undefined, undefined);
	controller.abort();
	release();
	await firstPending;
	const secondResult = await secondPending;
	assert.equal(secondResult.isError, true);
	assert.match(secondResult.content[0].text, /aborted/i);
	assert.equal(calls, 1);
});

test("cleans failed tails and isolates a role-switched endpoint while the old queue is blocked", async () => {
	const coordinator = createMemberMessageCoordinator();
	let releaseOld!: () => void;
	let oldStarted!: () => void;
	const oldStartedPromise = new Promise<void>((resolve) => {
		oldStarted = resolve;
	});
	const paths: string[] = [];
	const oldTools = setup(
		async (endpoint, command) => {
			paths.push(endpoint);
			oldStarted();
			await new Promise<void>((resolve) => {
				releaseOld = resolve;
			});
			return ack(command.mode === "steer" ? "steered" : "queued");
		},
		true,
		membership,
		{ coordinator },
	);
	const oldPending = oldTools
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "old" }, undefined, undefined, undefined);
	await oldStartedPromise;
	const switchedMembership = {
		...membership,
		manifest: {
			...manifest,
			members: manifest.members.map((member) =>
				member.name === "qa" ? { ...member, socketPath: "/other/qa.sock" } : member,
			),
		},
	};
	let newCompleted = false;
	const newTools = setup(
		async (endpoint) => {
			paths.push(endpoint);
			newCompleted = true;
			return ack("queued");
		},
		true,
		switchedMembership,
		{ coordinator },
	);
	const newResult = await newTools
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "new" }, undefined, undefined, undefined);
	assert.equal(newResult.isError, undefined);
	assert.equal(newCompleted, true);
	assert.deepEqual(paths, ["/project/.pi/bebop/sockets/qa.sock", "/other/qa.sock"]);
	releaseOld();
	await oldPending;
	assert.equal(coordinator.pendingKeyCount(), 0);

	const failureCoordinator = createMemberMessageCoordinator();
	let failureCalls = 0;
	const recovery = setup(
		async (_endpoint, command) => {
			failureCalls += 1;
			if (failureCalls === 1) throw new Error("target shutdown");
			return ack(command.mode === "steer" ? "steered" : "queued");
		},
		true,
		membership,
		{ coordinator: failureCoordinator },
	);
	const failed = recovery
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "fails" }, undefined, undefined, undefined);
	const recovered = recovery
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "recovers" }, undefined, undefined, undefined);
	const results = await Promise.all([failed, recovered]);
	assert.equal(results[0].isError, true);
	assert.equal(results[1].isError, undefined);
	assert.equal(failureCalls, 2);
	assert.equal(failureCoordinator.pendingKeyCount(), 0);
});

test("rejects response waiting and preserves membership target errors without RPC", async () => {
	let calls = 0;
	const send = async () => {
		calls += 1;
		return ack("direct");
	};
	const tools = setup(send);
	const response = await tools
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "x", wait_for: "response" }, undefined, undefined, undefined);
	assert.equal(response.isError, true);
	assert.match(response.content[0].text, /response.*unavailable/i);
	const self = await tools
		.get("send_follow_up")!
		.execute("call", { member: "dev", message: "x" }, undefined, undefined, undefined);
	assert.equal(self.isError, true);
	assert.match(self.content[0].text, /yourself/);
	const missing = await tools
		.get("send_follow_up")!
		.execute("call", { member: "missing", message: "x" }, undefined, undefined, undefined);
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /Unknown/);
	const unjoined = setup(send, false);
	const notJoined = await unjoined
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "x" }, undefined, undefined, undefined);
	assert.equal(notJoined.isError, true);
	assert.match(notJoined.content[0].text, /Not joined/);
	assert.equal(calls, 0);
});

test("forwards abort and reports offline endpoints", async () => {
	const controller = new AbortController();
	controller.abort();
	const tools = setup(async (_path, _command, options) => {
		assert.equal(options?.signal, controller.signal);
		throw new Error("aborted");
	});
	const result = await tools
		.get("send_immediate")!
		.execute("call", { member: "qa", message: "x" }, controller.signal, undefined, undefined);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /aborted/i);
});
