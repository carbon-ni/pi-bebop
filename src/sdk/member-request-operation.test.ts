import test from "node:test";
import assert from "node:assert/strict";
import { RequestOutcomeRegistry } from "../domain/member-request.ts";
import { BebopClientError } from "./errors.ts";
import {
	createInProcessMemberRequestOperation,
	createRemoteMemberRequestOperation,
	type InProcessMemberRequestFlowCapability,
} from "./member-request-operation.ts";

function setup() {
	const registry = new RequestOutcomeRegistry();
	let trusted = true;
	let membership: any = {
		member: { name: "requester", role: "developer", socketPath: "/requester.sock" },
		socketPath: "/requester.sock",
		manifest: {
			members: [
				{ name: "requester", role: "developer", socketPath: "/requester.sock" },
				{ name: "reviewer", role: "reviewer", socketPath: "/reviewer.sock" },
			],
		},
	};
	let sequence = 0;
	let responseDelay = 0;
	const flow: InProcessMemberRequestFlowCapability = {
		sendMemberRequest: async (input) => {
			const requestId = `request-${++sequence}`;
			const member = { name: "reviewer", role: "reviewer" };
			registry.registerOutbound({
				requestId,
				member,
				now: Date.now(),
				maxWaitSeconds: input.maxWaitSeconds,
				timeoutSeconds: input.timeoutSeconds,
			});
			registry.acceptOutbound(requestId, Date.now());
			return { requestId, member: { kind: "member", ...member, socketPath: "/reviewer.sock" } };
		},
		sendGuestMemberRequest: async () => {
			throw new Error("guest not expected");
		},
		waitForRequestOutcomeById: (requestId, onUpdate) => registry.waitForRequest(requestId, onUpdate),
		respondToMemberRequest: async (input) => {
			await new Promise((resolve) => setTimeout(resolve, responseDelay));
			registry.resolveInboundResponse(input.requestId ?? "inbound");
		},
	};
	const operation = createInProcessMemberRequestOperation({
		surface: {
			getMembership: () => membership,
			isTrusted: () => trusted,
			getMemberRequestFlow: () => flow,
		},
	});
	return {
		operation,
		registry,
		setTrusted: (value: boolean) => (trusted = value),
		setMembership: (value: any) => (membership = value),
		setResponseDelay: (value: number) => (responseDelay = value),
	};
}

test("in-process start and repeated waits share one registry and keep pending nonterminal", async () => {
	const { operation, registry } = setup();
	const accepted = await operation.startMemberRequest("reviewer", { message: "Review this" });
	registry.armOutboundIdle(accepted.requestId, Date.now());
	registry.resolvePendingAfterIdle(accepted.requestId);
	const pending = await operation.waitForRequestOutcome(accepted.requestId);
	assert.equal(pending.kind, "pending");
	const next = operation.waitForRequestOutcome(accepted.requestId);
	registry.resolveResponse({
		requestId: accepted.requestId,
		member: { name: "reviewer", role: "reviewer" },
		message: "Done",
		instructions: ["kept"],
	});
	const response = await next;
	assert.equal(response.kind, "response");
	assert.equal(registry.outboundCount(), 0);
});

test("in-process wait cancellation releases only the waiter and never changes request state", async () => {
	const { operation, registry } = setup();
	const accepted = await operation.startMemberRequest("reviewer", { message: "Review this" });
	const controller = new AbortController();
	const waiting = operation.waitForRequestOutcome(accepted.requestId, { signal: controller.signal });
	controller.abort();
	await assert.rejects(waiting, (error: unknown) => error instanceof BebopClientError && error.code === "aborted");
	assert.equal(registry.outboundCount(), 1);
});

test("in-process response observes cancellation while delivery is pending", async () => {
	const setupResult = setup();
	setupResult.setResponseDelay(100);
	const controller = new AbortController();
	const responding = setupResult.operation.respondToMemberRequest(
		undefined,
		{ message: "Acknowledged" },
		{ signal: controller.signal, timeoutMs: 80 },
	);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(
		responding,
		(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
	);
});

test("in-process operations read live trust and membership authority", async () => {
	const setupResult = setup();
	setupResult.setTrusted(false);
	await assert.rejects(
		setupResult.operation.startMemberRequest("reviewer", { message: "Review this" }),
		(error: unknown) => error instanceof BebopClientError && error.code === "untrusted",
	);
	setupResult.setTrusted(true);
	setupResult.setMembership(null);
	await assert.rejects(
		setupResult.operation.startMemberRequest("reviewer", { message: "Review this" }),
		(error: unknown) => error instanceof BebopClientError && error.code === "not-joined",
	);
});

function remoteSetup() {
	const calls: string[] = [];
	const operation = createRemoteMemberRequestOperation({
		sendStart: async () => {
			calls.push("start");
			return { accepted: true, requestId: "request-1", member: { name: "reviewer", role: "reviewer" } };
		},
		sendWait: async () => {
			calls.push("wait");
			return {
				kind: "pending",
				requestId: "request-1",
				member: { name: "reviewer", role: "reviewer" },
				reason: "pending-after-idle",
			};
		},
		sendResponse: async () => {
			calls.push("respond");
			return {};
		},
	});
	return { calls, operation };
}

const remotePaths = [
	{
		name: "start",
		invoke: (
			operation: ReturnType<typeof remoteSetup>["operation"],
			options: { signal?: AbortSignal; timeoutMs?: number },
		) =>
			operation.startMemberRequest(
				"reviewer",
				{ message: "Review this", timeoutSeconds: 1, maxWaitSeconds: 60 },
				options,
			),
	},
	{
		name: "wait",
		invoke: (
			operation: ReturnType<typeof remoteSetup>["operation"],
			options: { signal?: AbortSignal; timeoutMs?: number },
		) => operation.waitForRequestOutcome("request-1", options),
	},
	{
		name: "respond",
		invoke: (
			operation: ReturnType<typeof remoteSetup>["operation"],
			options: { signal?: AbortSignal; timeoutMs?: number },
		) => operation.respondToMemberRequest("request-1", { message: "Acknowledged" }, options),
	},
] as const;

for (const path of remotePaths) {
	test(`remote ${path.name} validates aborted options before dispatch`, async () => {
		const { operation, calls } = remoteSetup();
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			path.invoke(operation, { signal: controller.signal }),
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
		assert.deepEqual(calls, []);
	});

	test(`remote ${path.name} validates timeout options before dispatch`, async () => {
		const { operation, calls } = remoteSetup();
		await assert.rejects(
			path.invoke(operation, { timeoutMs: 49 }),
			(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
		);
		assert.deepEqual(calls, []);
	});

	test(`remote ${path.name} dispatches valid option bounds`, async () => {
		const { operation, calls } = remoteSetup();
		await path.invoke(operation, { timeoutMs: 50 });
		await path.invoke(operation, { timeoutMs: 7_210_000 });
		assert.deepEqual(calls, [path.name, path.name]);
	});
}

test("remote start validates max wait after the effective request timeout", async () => {
	const { operation, calls } = remoteSetup();
	await assert.rejects(
		operation.startMemberRequest("reviewer", { message: "Review this", timeoutSeconds: 120, maxWaitSeconds: 120 }),
		(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
	);
	assert.deepEqual(calls, []);
});
