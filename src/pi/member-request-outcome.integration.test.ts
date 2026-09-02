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
import { registerWaitForRequestOutcomeTool } from "../tools/member-request.ts";

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
 * into model context. The source tool call blocks until the target sends a
 * full correlated Response over the real socket.
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

function within<T>(ms: number, promise: Promise<T>, message: string): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(handle));
}

test("source wait blocks through a real socket and resolves the same call with the full Response", async (t) => {
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

	// --- Source runtime: real flow + real RPC client ---
	const sourceMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: sourcePath }, [
		{ name: "Kelly", role: "qa", socketPath: targetPath },
	]);
	let requestSequence = 0;
	let timerSequence = 0;
	const timers = new Map<number, { callback: () => void; delay: number }>();
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
		createRequestId: () => `request-real-${++requestSequence}`,
		setTimeout: (callback, delay) => {
			const handle = ++timerSequence;
			timers.set(handle, { callback, delay });
			return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as unknown as number);
		},
	});
	const sourceState = createSocketState();
	sourceState.memberRequestFlow = flow;
	const tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
	registerWaitForRequestOutcomeTool({ registerTool: (tool) => tools.push(tool as never) } as never, sourceState);
	const wait = tools.find((tool) => tool.name === "wait_for_request_outcome")!;

	const accepted = await flow.sendMemberRequest({
		membership: sourceMembership,
		member: "Kelly",
		message: "Deliver X",
		timeoutSeconds: 60,
	});
	assert.equal(accepted.requestId, "request-real-1");
	assert.equal(server.acceptedIntoContext.length, 1, "target must accept the request into model context");

	let settled = false;
	const pending = wait.execute("id", {} as never, new AbortController().signal).then((result) => {
		settled = true;
		return result;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "the same tool call remains blocked while the request is active");

	const inbound = server.targetState.memberRequestFlow!.registry.selectInbound("request-real-1");
	assert.equal(inbound.ok, true);
	if (inbound.ok) {
		await server.targetState.memberRequestFlow!.respondToMemberRequest({
			message: "Evidence attached: 3 findings",
			instructions: ["review finding 1", "confirm gate"],
			requestId: "request-real-1",
			member: { name: "Kelly", role: "qa" },
		});
	}
	const result = (await within(2_000, pending, "source wait did not resolve after Response")) as {
		details: { result: { kind: string; message?: string; instructions?: readonly string[] } };
	};
	assert.equal(result.details.result.kind, "response");
	assert.equal(result.details.result.message, "Evidence attached: 3 findings");
	assert.deepEqual(result.details.result.instructions, ["review finding 1", "confirm gate"]);
	assert.equal(flow.registry.outboundCount(), 0);

	// The same real socket path also covers a bounded terminal outcome: idle is
	// nonterminal, then the exact captured grace callback resolves the blocked
	// call directly.
	const timeoutAccepted = await flow.sendMemberRequest({
		membership: sourceMembership,
		member: "Kelly",
		message: "Bounded evidence request",
		timeoutSeconds: 1,
	});
	assert.equal(timeoutAccepted.requestId, "request-real-2");
	const timeoutPending = wait.execute("id", {} as never, new AbortController().signal);
	await new Promise((resolve) => setImmediate(resolve));
	emitIdleSettled(server.targetState, { isIdle: () => true } as never);
	await within(
		2_000,
		(async () => {
			while (!flow.registry.getOutbound("request-real-2")?.idleArmed)
				await new Promise((resolve) => setImmediate(resolve));
		})(),
		"source grace was not armed",
	);
	const graceTimer = [...timers.entries()].find(([, timer]) => timer.delay === 1_000);
	assert.ok(graceTimer, "post-idle grace timer was not captured");
	graceTimer[1].callback();
	const timeoutResult = (await within(2_000, timeoutPending, "bounded wait did not resolve")) as {
		details: { result: { kind: string; reason?: string } };
	};
	assert.equal(timeoutResult.details.result.kind, "timeout");
	assert.equal(timeoutResult.details.result.reason, "response-after-idle");
});
