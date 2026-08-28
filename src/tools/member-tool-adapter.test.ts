import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { parseCrewManifest } from "../domain/index.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import type { RpcClientOptions } from "../infra/rpc-client.ts";
import { createSocketState } from "../pi/control-runtime.ts";
import {
	createMemberMessageCoordinator,
	MemberMessageError,
	sendMemberMessage,
} from "../application/member-message.ts";
import { registerSendFollowUpTool } from "./send-follow-up.ts";
import { registerRedirectMemberTool } from "./redirect-member.ts";

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
	dependencies: any = { coordinator: createMemberMessageCoordinator() },
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
	const adapterDependencies = {
		transport: { send: sendRpcCommand },
		resolveEndpoint: async (socketPath: string) => socketPath,
		...dependencies,
	};
	registerSendFollowUpTool(pi, state, adapterDependencies);
	registerRedirectMemberTool(pi, state, adapterDependencies);
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

test("application omission defaults to follow-up wire delivery and coordinator queue", async () => {
	let command: any;
	const outcome = await sendMemberMessage(
		{ membership, member: "qa", message: "default", sender: undefined },
		{
			transport: {
				send: async (_endpoint, value) => {
					command = value;
					return ack("queued");
				},
			},
			resolveEndpoint: async (socketPath) => socketPath,
			coordinator: createMemberMessageCoordinator(),
		},
	);
	assert.equal(command.delivery, "follow_up");
	assert.deepEqual(command.payload, {
		content: "default",
		origin: { kind: "crew", name: "dev", role: "developer" },
	});
	assert.equal(outcome.disposition, "queued");
});

test("registers only intent-named tools with compact parameters and teaching descriptions", () => {
	const tools = setup(async () => ack("queued"));
	assert.deepEqual([...tools.keys()], ["send_follow_up", "redirect_member"]);
	for (const tool of tools.values()) {
		assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), [
			"instructions",
			"member",
			"message",
			"wait_for",
		]);
		assert.equal(tool.description.includes("mode"), false);
		assert.equal(Value.Check(tool.parameters, { member: "qa", message: "x" }), true);
		assert.equal(Value.Check(tool.parameters, { member: "qa", message: "x", mode: "steer" }), false);
		assert.equal(Value.Check(tool.parameters, { member: "qa", message: "x", extra: true }), false);
	}
	assert.match(tools.get("send_follow_up")!.description, /information/i);
	assert.match(tools.get("send_follow_up")!.description, /no correlated Response/i);
	assert.doesNotMatch(tools.get("send_follow_up")!.description, /by default|default coordination/i);
	assert.match(tools.get("redirect_member")!.description, /redirect.*active/i);
});

test("intent tools reject invalid instruction payloads before endpoint or transport", async () => {
	let calls = 0;
	let endpointCalls = 0;
	const tools = setup(
		async () => {
			calls += 1;
			return ack("queued");
		},
		true,
		membership,
		{
			coordinator: createMemberMessageCoordinator(),
			resolveEndpoint: async (socketPath: string) => {
				endpointCalls += 1;
				return socketPath;
			},
		},
	);
	const aggregateOverflow = Array.from({ length: 32 }, () => "x".repeat(31_250));
	const invalidMatrices = [["   "], ["\0"], ["😀".repeat(25_001)], Array(33).fill("x"), aggregateOverflow];
	for (const name of ["send_follow_up", "redirect_member"]) {
		for (const instructions of invalidMatrices) {
			const result = await tools
				.get(name)!
				.execute("call", { member: "qa", message: "hello", instructions }, undefined, undefined, undefined);
			assert.equal(result.isError, true, `${name} invalid instructions`);
		}
	}
	assert.equal(calls, 0);
	assert.equal(endpointCalls, 0);
});

test("both intent tools preserve ordered instructions and current origin with callback route", async () => {
	const calls: any[] = [];
	const tools = setup(async (_path, command) => {
		calls.push(command);
		return ack("queued");
	});
	for (const name of ["send_follow_up", "redirect_member"]) {
		const result = await tools
			.get(name)!
			.execute(
				"call",
				{ member: "qa", message: "hello", instructions: [" first\n", "second"], wait_for: "accepted" },
				undefined,
				undefined,
				undefined,
			);
		assert.equal(result.isError, undefined);
	}
	for (const command of calls) {
		assert.deepEqual(command.payload.instructions, [" first\n", "second"]);
		assert.deepEqual(command.payload.origin, { kind: "crew", name: "dev", role: "developer" });
		assert.deepEqual(command.payload.replyTo, { sessionId: "dev-session", sessionName: "dev" });
	}
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
		.get("redirect_member")!
		.execute("call", { member: "qa", message: "now" }, undefined, undefined, undefined);
	assert.equal(follow.isError, undefined);
	assert.equal(immediate.isError, undefined);
	assert.equal(calls[0].command.delivery, "follow_up");
	assert.equal(calls[1].command.delivery, "immediate");
	assert.deepEqual(
		calls.map((call) => call.options),
		[
			{ signal: undefined, classifyLostAck: true },
			{ signal: undefined, classifyLostAck: true },
		],
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
		const message = command.payload.content.split("\n")[0];
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
		.get("redirect_member")!
		.execute("call", { member: "qa", message: "redirect one" }, undefined, undefined, undefined);
	const immediateTwo = tools
		.get("redirect_member")!
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
			return ack(command.delivery === "immediate" ? "steered" : "queued");
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
			return ack(command.delivery === "immediate" ? "steered" : "queued");
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
	assert.match(results[0].content[0].text, /offline.*target shutdown/i);
	assert.equal(results[0].details.error, "offline");
	assert.equal(results[1].isError, undefined);
	assert.equal(failureCalls, 2);
	assert.equal(failureCoordinator.pendingKeyCount(), 0);
});

test("classifies every representative invalid acknowledgement, remote rejection, and true offline error", async () => {
	const invalidValues = [
		{},
		{ deliveryId: "", disposition: "direct" },
		{ deliveryId: "delivery-1", disposition: "invalid" },
		{ deliveryId: "delivery-1", disposition: "direct", extra: true },
		{ deliveryId: 1, disposition: "direct" },
		null,
	];
	for (const [index, data] of invalidValues.entries()) {
		const invalid = setup(async () => ({
			response: { type: "response", command: "send", success: true, id: `invalid-${index}`, data },
		}));
		const invalidResult = await invalid
			.get("send_follow_up")!
			.execute("call", { member: "qa", message: "x" }, undefined, undefined, undefined);
		assert.equal(invalidResult.details.error, "invalid-ack", `invalid acknowledgement ${index}`);
		assert.equal(invalidResult.isError, true, `invalid acknowledgement ${index}`);
	}
	const remote = setup(async () => ({
		response: { type: "response", command: "send", success: false, id: "remote", error: "busy" },
	}));
	const remoteResult = await remote
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "x" }, undefined, undefined, undefined);
	assert.equal(remoteResult.details.error, "remote-rejected");
	const offline = setup(async () => {
		throw new Error("ENOENT socket");
	});
	const offlineResult = await offline
		.get("send_follow_up")!
		.execute("call", { member: "qa", message: "x" }, new AbortController().signal, undefined, undefined);
	assert.equal(offlineResult.details.error, "offline");
	assert.match(offlineResult.content[0].text, /offline.*target shutdown/i);
	assert.doesNotMatch(offlineResult.content[0].text, /ENOENT/i);
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

test("both intent tools expose actionable parity for typed and raw failures", async () => {
	for (const name of ["send_follow_up", "redirect_member"] as const) {
		for (const failure of [
			new MemberMessageError("remote-rejected", "remote error at /var/folders/qa/private.sock"),
			new Error("dependency failed at /tmp/quarantine-123"),
		]) {
			const tools = setup(async () => {
				throw failure;
			});
			const result = await tools
				.get(name)!
				.execute("call", { member: "qa", message: "x" }, undefined, undefined, undefined);
			assert.equal(result.isError, true, name);
			assert.equal(typeof result.details.actionableError, "object", name);
			assert.equal(result.details.error, result.details.actionableError.code, name);
			assert.equal(result.content[0].text, result.details.actionableError.message, name);
			assert.doesNotMatch(result.content[0].text, /private\.sock|quarantine-123|remote error at/i, name);
		}
	}
});

test("forwards abort and reports offline endpoints", async () => {
	const controller = new AbortController();
	controller.abort();
	const tools = setup(async (_path, _command, options) => {
		assert.equal(options?.signal, controller.signal);
		throw new Error("aborted");
	});
	const result = await tools
		.get("redirect_member")!
		.execute("call", { member: "qa", message: "x" }, controller.signal, undefined, undefined);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /aborted/i);
});
