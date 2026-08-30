import test from "node:test";
import assert from "node:assert/strict";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleMemberRequest } from "./member-request.ts";
test("member request rejects an unjoined runtime", async () => {
	const c = handlerContext();
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "r",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal((c.responses[0] as any).error, "not-joined");
});

test("deferred member request stays invisible until the gate hands it off", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	let delivered!: () => void;
	let accepted = false;
	let notified = false;
	c.state.memberRequestFlow = {
		registerInboundRequest: () => undefined,
		acceptInboundRequest: () => {
			accepted = true;
		},
		removeInboundRequest: () => undefined,
		registry: { failBeforeAcceptance: () => undefined },
	} as never;
	c.notifyAcceptedMessage = () => {
		notified = true;
	};
	c.state.modelDelivery = {
		sendDurably: async (_message: unknown, _options: unknown, onDelivered: () => void) => {
			delivered = onDelivered;
			return { disposition: "deferred", deferred: true };
		},
	} as never;
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "deferred-request",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal(c.responses.length, 0);
	assert.equal(accepted, false);
	assert.equal(notified, false);
	delivered();
	assert.equal(accepted, true);
	assert.equal(notified, true);
	assert.deepEqual((c.responses[0] as any).data, {
		accepted: true,
		requestId: "deferred-request",
		member: { name: "Dave", role: "dev" },
	});
});

test("closed live request channel suppresses deferred acknowledgement before timer handoff", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	let delivered!: () => void;
	let removed = 0;
	let accepted = false;
	const socket = Object.assign(c.socket, { destroyed: false });
	c.socket = socket;
	c.state.memberRequestFlow = {
		registerInboundRequest: () => undefined,
		acceptInboundRequest: () => {
			accepted = true;
		},
		removeInboundRequest: () => {
			removed++;
		},
		registry: { failBeforeAcceptance: () => undefined },
	} as never;
	c.state.modelDelivery = {
		sendDurably: async (_message: unknown, _options: unknown, onDelivered: () => void) => {
			delivered = onDelivered;
			return { disposition: "deferred", deferred: true };
		},
	} as never;
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "closed-before-handoff",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal(c.responses.length, 0);
	socket.destroyed = true;
	socket.emit("close");
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	delivered();
	assert.equal(accepted, false);
	assert.equal(removed, 2, "socket cleanup and handoff guard each remove the closed request");
	assert.equal(c.responses.length, 0);
});

test("member request registers and acknowledges a configured crew origin", async () => {
	const c = handlerContext();
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.state.context!.isProjectTrusted = () => true;
	let registered = false;
	c.state.memberRequestFlow = {
		registerInboundRequest: () => {
			registered = true;
		},
		acceptInboundRequest: () => undefined,
		removeInboundRequest: () => undefined,
		registry: { failBeforeAcceptance: () => undefined },
	} as never;
	await handleMemberRequest(
		{
			type: "member_request",
			requestId: "r",
			payload: { content: "x", instructions: [], origin: { kind: "crew", name: "Mary", role: "po" } },
			timeoutSeconds: 1,
			id: "1",
		},
		c,
	);
	assert.equal(registered, true);
	assert.deepEqual((c.responses[0] as any).data, {
		accepted: true,
		requestId: "r",
		member: { name: "Dave", role: "dev" },
	});
});
