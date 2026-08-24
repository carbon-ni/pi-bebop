import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { sendMemberRequest } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "./control-runtime.ts";

/**
 * TASK-0075 real two-runtime lifecycle (not manual settle only).
 *
 * Source runtime: the real MemberRequestFlow wired exactly as extension.ts
 * wires it (real `sendMemberRequest` RPC client + real endpoint resolution)
 * with an injected fake clock, so the pre-dispatch deadline can never be the
 * trigger that resolves the wait.
 *
 * Target runtime: the real `createRpcServer` + real `handleCommand`
 * member_request path with a Pi stub whose `sendMessage` accepts the request
 * into model context; the target then reaches the real `agent_settled` path
 * (`emitIdleSettled`) without ever sending a Response. The source wait must
 * resolve immediately to `idle-without-response`.
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

test("source wait resolves immediately to idle-without-response after real target agent_settled", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-request-outcome-"));
	const targetPath = path.join(root, "target.sock");
	const sourcePath = path.join(root, "source.sock");
	const server = await (async () => {
		// --- Target runtime: real handleCommand member_request path ---
		const targetState = createSocketState();
		targetState.membershipRuntime = {
			getMembership: () =>
				joinedMembership({ name: "Kelly", role: "qa", socketPath: targetPath }, [
					{ name: "Tony", role: "lead", socketPath: sourcePath },
				]),
		} as never;
		targetState.context = {
			hasUI: false,
			sessionManager: { getSessionId: () => "target", getSessionName: () => null, getEntries: () => [] },
			isIdle: () => false,
			isProjectTrusted: () => true,
		} as never;
		const acceptedIntoContext: unknown[] = [];
		const pi = {
			sendMessage: (message: unknown, options: unknown) => {
				acceptedIntoContext.push({ message, options });
			},
		} as never;
		targetState.memberRequestFlow = new MemberRequestFlow({
			transport: {
				open: async () => ({ close: () => undefined }),
				respond: async () => undefined,
			},
			resolveEndpoint: resolveMemberEndpoint,
		});
		const targetServer = await createRpcServer(targetPath, (command, socket) =>
			handleCommand(pi, targetState, command, socket),
		);
		t.after(async () => {
			await closeRpcServer(targetServer);
			await fs.rm(root, { recursive: true, force: true });
		});
		return { targetState, acceptedIntoContext };
	})();

	// --- Source runtime: real flow + real RPC client, fake clock ---
	const sourceMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: sourcePath }, [
		{ name: "Kelly", role: "qa", socketPath: targetPath },
	]);
	const firedDeadlines: string[] = [];
	const flow = new MemberRequestFlow({
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
		now: () => 1_000,
		createRequestId: () => "request-real-1",
		setTimeout: (callback) => {
			const handle = setTimeout(() => {
				firedDeadlines.push("fired");
				callback();
			}, 30_000);
			return handle;
		},
		clearTimeout: (handle) => clearTimeout(handle),
	});

	const accepted = await flow.sendMemberRequest({
		membership: sourceMembership,
		member: "Kelly",
		message: "Deliver X",
	});
	assert.equal(accepted.requestId, "request-real-1");
	assert.equal(server.acceptedIntoContext.length, 1, "target must accept the request into model context");

	const pending = waitForOutcome(flow);
	// Target reaches the real agent_settled path without any Response.
	emitIdleSettled(server.targetState, { isIdle: () => true } as never);

	const update = await within(
		2_000,
		pending,
		"source wait stayed blocked after target agent_settled without Response (outbound idle never armed)",
	);
	assert.deepEqual(update, {
		kind: "idle-without-response",
		requestId: "request-real-1",
		member: { name: "Kelly", role: "qa" },
	});
	// Immediate idle, not deadline: the pre-dispatch timer was cleared, never fired.
	assert.deepEqual(firedDeadlines, []);
	assert.equal(flow.registry.outboundCount(), 0);
	// Terminal exactly once: a second wait has nothing pending.
	assert.deepEqual(
		flow.waitForRequestOutcome(() => undefined),
		{ ok: false, code: "no-pending-requests" },
	);
});
