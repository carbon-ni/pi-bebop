import test from "node:test";
import assert from "node:assert/strict";
import { RequestOutcomeRegistry } from "../domain/member-request.ts";
import { BebopClientError } from "./errors.ts";
import {
	createInProcessMemberRequestOperation,
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
	await assert.rejects(responding, (error: unknown) => error instanceof BebopClientError && error.code === "aborted");
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
