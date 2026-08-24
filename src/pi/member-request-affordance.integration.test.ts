import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { sendMemberRequest, sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "./control-runtime.ts";
import { isMessagePayload } from "../domain/index.ts";

/**
 * TASK-0076 affordance integration: real two runtimes over Unix sockets.
 *
 * Happy path: requester sends a Member request; the responder's model context
 * visibly carries the bounded `[member request]` marker + Request ID +
 * respond instruction; the responder sends one correlated Response; the
 * requester alone receives the response outcome.
 *
 * Negative path: an ordinary Follow-up renders with the `[follow-up]` marker
 * (no correlated Response expected), creates zero request state on the target,
 * and the sender's request-outcome wait fails immediately — message content is
 * never heuristically parsed or upgraded.
 */

function joinedMembership(
	member: { name: string; role: string; socketPath: string },
	others: Array<{ name: string; role: string; socketPath: string }>,
) {
	return {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: member.socketPath,
		member,
		manifest: { members: [member, ...others] },
	};
}

async function targetRuntime(
	targetPath: string,
	requesterPath: string,
): Promise<{
	state: ReturnType<typeof createSocketState>;
	acceptedIntoContext: Array<{ message: unknown; options: unknown }>;
	server: Awaited<ReturnType<typeof createRpcServer>>;
}> {
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () =>
			joinedMembership({ name: "Kelly", role: "qa", socketPath: targetPath }, [
				{ name: "Tony", role: "lead", socketPath: requesterPath },
			]),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "target", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const acceptedIntoContext: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		sendMessage: (message: unknown, options: unknown) => {
			acceptedIntoContext.push({ message, options });
		},
	} as never;
	state.memberRequestFlow = new MemberRequestFlow({
		transport: {
			open: async () => ({ close: () => undefined }),
			respond: async () => undefined,
		},
		resolveEndpoint: resolveMemberEndpoint,
	});
	const server = await createRpcServer(targetPath, (command, socket) => handleCommand(pi, state, command, socket));
	return { state, acceptedIntoContext, server };
}

function waitForOutcome(flow: MemberRequestFlow): Promise<unknown> {
	return new Promise((resolve) => {
		const result = flow.waitForRequestOutcome((update) => resolve(update));
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.kind, "waiting");
	});
}

function within<T>(ms: number, promise: Promise<T>, message: string): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(handle));
}

test("TASK-0076 happy: requester sends, responder sees the request marker, responder responds, requester alone receives outcome", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-request-affordance-"));
	const targetPath = path.join(root, "target.sock");
	const requesterPath = path.join(root, "requester.sock");
	try {
		const target = await targetRuntime(targetPath, requesterPath);
		t.after(async () => {
			await closeRpcServer(target.server);
		});

		const requesterMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: requesterPath }, [
			{ name: "Kelly", role: "qa", socketPath: targetPath },
		]);
		const requesterFlow = new MemberRequestFlow({
			transport: {
				open: (endpoint, command, options) =>
					sendMemberRequest(endpoint, command, {
						timeout: options.timeoutMs,
						signal: options.signal,
						onUpdate: options.onUpdate,
					}),
				respond: async (channel, update) => channel.send(update),
			},
			resolveEndpoint: resolveMemberEndpoint,
			createRequestId: () => "request-afford-1",
		});

		const accepted = await requesterFlow.sendMemberRequest({
			membership: requesterMembership,
			member: "Kelly",
			message: "Please QA the TASK-0076 changes and report a verdict",
		});
		assert.equal(accepted.requestId, "request-afford-1");

		// Responder's model context structurally carries the request marker.
		const inbound = target.acceptedIntoContext[0]!.message as { content: string; details?: unknown };
		assert.match(inbound.content, /^\[member request\]/);
		assert.match(inbound.content, /request-afford-1/);
		assert.match(inbound.content, /respond_to_member_request/);
		const payload = (inbound.details as { messagePayload?: unknown }).messagePayload;
		assert.equal(isMessagePayload(payload), true);
		assert.match(inbound.content, /Please QA the TASK-0076 changes and report a verdict/);

		// Requester waits; responder sends one correlated Response.
		const pending = waitForOutcome(requesterFlow);
		await target.state.memberRequestFlow!.respondToMemberRequest({
			message: "QA verdict: approved, coverage 96.8% and gate green",
			member: { name: "Kelly", role: "qa" },
		});
		const update = await within(2_000, pending, "requester did not receive the correlated Response");
		assert.deepEqual(update, {
			kind: "response",
			requestId: "request-afford-1",
			member: { name: "Kelly", role: "qa" },
			message: "QA verdict: approved, coverage 96.8% and gate green",
			instructions: [],
		});
		// Terminal exactly once; the requester alone received it.
		assert.deepEqual(
			requesterFlow.waitForRequestOutcome(() => undefined),
			{
				ok: false,
				code: "no-pending-requests",
			},
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("TASK-0076 negative: ordinary Follow-up is marked no-correlated-Response and creates no request state", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-followup-affordance-"));
	const targetPath = path.join(root, "target.sock");
	const requesterPath = path.join(root, "requester.sock");
	try {
		const target = await targetRuntime(targetPath, requesterPath);
		t.after(async () => {
			await closeRpcServer(target.server);
		});

		// Ordinary Follow-up through the real send command path.
		const payload = {
			content: "FYI: CI is green, no response needed",
			origin: { kind: "crew" as const, name: "Tony", role: "lead" },
		};
		const sent = await sendRpcCommand(
			targetPath,
			{ type: "send", payload, delivery: "follow_up" },
			{ timeout: 5_000 },
		);
		assert.equal(sent.response.success, true);

		// Model context carries the structural follow-up marker.
		const inbound = target.acceptedIntoContext[0]!.message as { content: string };
		assert.match(inbound.content, /^\[follow-up\]/);
		assert.match(inbound.content, /no correlated Response expected/i);
		assert.doesNotMatch(inbound.content, /respond_to_member_request|wait_for_request_outcome|\[member request\]/);

		// No request state was created on the target.
		assert.equal(target.state.memberRequestFlow!.registry.inboundCount(), 0);

		// The sender's request-outcome wait fails immediately: ordinary
		// Follow-up never creates a pending outbound request.
		const requesterFlow = new MemberRequestFlow({
			transport: {
				open: async () => ({ close: () => undefined }),
				respond: async () => undefined,
			},
			resolveEndpoint: resolveMemberEndpoint,
		});
		assert.deepEqual(
			requesterFlow.waitForRequestOutcome(() => undefined),
			{
				ok: false,
				code: "no-pending-requests",
			},
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
