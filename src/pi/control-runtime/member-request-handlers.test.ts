import test from "node:test";
import assert from "node:assert/strict";

import {
	createMemberRequestHandlerContext,
	handleMemberRequestList,
	handleMemberRequestStart,
	type MemberRequestHandlerContext,
} from "./member-request-handlers.ts";
import { createSocketState } from "../control-runtime.ts";

function membership() {
	return {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/tmp/alex.sock",
		member: { name: "Alex", role: "dev", socketPath: "/tmp/alex.sock" },
		manifest: {
			members: [
				{ name: "Alex", role: "dev", socket: "/tmp/alex.sock" },
				{ name: "Mary", role: "po", socket: "/tmp/mary.sock" },
			],
		},
	};
}

function handlerContext(overrides: Partial<MemberRequestHandlerContext> = {}): MemberRequestHandlerContext {
	return {
		pi: { sendMessage: () => undefined } as never,
		socket: { once: () => undefined } as never,
		respond: () => undefined,
		getMembership: () => membership(),
		getMemberRequestFlow: () => undefined,
		isProjectTrusted: () => true,
		getGuestMembershipRuntime: () => undefined,
		getGuestAdmissionRuntime: () => undefined,
		notifyAcceptedMessage: () => undefined,
		...overrides,
	};
}

test("Member Request handlers can be constructed from only their narrow capabilities", async () => {
	const responses: Array<{ success: boolean; data?: unknown; error?: string }> = [];
	const context = handlerContext({
		getMemberRequestFlow: () =>
			({
				listRequestSummaries: (direction: string) => [
					{ direction, requestId: "request-1", member: { name: "Mary", role: "po" }, state: "idle" },
				],
			}) as never,
		respond: (success, _command, data, error) => responses.push({ success, data, error }),
	});

	await handleMemberRequestList(context, { type: "member_request_list", direction: "inbound", id: "list-1" });

	assert.deepEqual(responses, [
		{
			success: true,
			data: {
				requests: [
					{
						direction: "inbound",
						requestId: "request-1",
						member: { name: "Mary", role: "po" },
						state: "idle",
					},
				],
				omitted: 0,
			},
			error: undefined,
		},
	]);
});

test("Member Request dispatch capabilities read live membership, trust, and flow state", async () => {
	const state = createSocketState();
	let currentMembership: ReturnType<typeof membership> | null = membership();
	let trusted = true;
	let currentFlow: unknown = { listRequestSummaries: () => [] };
	state.membershipRuntime = { getMembership: () => currentMembership } as never;
	state.context = { isProjectTrusted: () => trusted } as never;
	state.memberRequestFlow = currentFlow as never;

	const context = createMemberRequestHandlerContext({
		pi: { sendMessage: () => undefined },
		state,
		ctx: {} as never,
		socket: { once: () => undefined },
		respond: () => undefined,
		id: "list-1",
	} as never);

	assert.equal(context.getMembership()?.member.name, "Alex");
	assert.equal(context.isProjectTrusted(), true);
	assert.equal(context.getMemberRequestFlow(), currentFlow);

	currentMembership = null;
	trusted = false;
	currentFlow = undefined;
	state.memberRequestFlow = currentFlow as never;
	assert.equal(context.getMembership(), null);
	assert.equal(context.isProjectTrusted(), false);
	assert.equal(context.getMemberRequestFlow(), undefined);
});

test("Guest request start validates approval explicitly before using guest credentials", async () => {
	const responses: Array<{ success: boolean; error?: string }> = [];
	const context = handlerContext({
		getMembership: () => null,
		getMemberRequestFlow: () => ({ sendGuestMemberRequest: async () => ({}) }) as never,
		getGuestMembershipRuntime: () =>
			({
				credentials: () => undefined,
				getMemberSocket: () => undefined,
			}) as never,
		respond: (success, _command, _data, error) => responses.push({ success, ...(error ? { error } : {}) }),
	});

	await handleMemberRequestStart(context, {
		type: "member_request_start",
		crew: "crew-1",
		target: "Mary",
		message: "Please review this.",
		id: "start-1",
	});

	assert.deepEqual(responses, [{ success: false, error: "not-approved" }]);
});
