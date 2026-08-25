import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sendMemberIdleWait, sendMemberRequest } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { probeMemberEndpoint } from "../infra/member-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "./control-runtime.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { YieldingWaitRegistry } from "../domain/index.ts";
import { YieldingWaitRuntime } from "./wait-resume.ts";
import { registerWaitForMemberIdleTool } from "../tools/wait-for-member-idle.ts";
import { registerWaitForRequestOutcomeTool } from "../tools/member-request.ts";

/**
 * TASK-0077 real two-runtime round trips (not unit seams only).
 *
 * Both wait tools are wired exactly as extension.ts wires them: real RPC
 * clients, real Unix-socket servers running the real `handleCommand` paths,
 * and a real YieldingWaitRuntime whose `deliver` captures the one-shot
 * resume. Proves the deadlock break (each wait returns a deterministic
 * `yielded` result immediately instead of holding the run busy) and the
 * exactly-once resume on the real lifecycle terminal.
 */

function joinedMembership(
	member: { name: string; role: string; socketPath: string },
	others: Array<{ name: string; role: string; socketPath: string }> = [],
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

/** Await until both servers registered their one-shot subscriptions (bounded, no wall-clock dependence). */
function waitForSubscriptions(
	states: Array<{ idleWaitSubscriptions: Array<unknown> }>,
	deadlineMs = 2_000,
): Promise<void> {
	const started = Date.now();
	return new Promise<void>((resolve, reject) => {
		const check = () => {
			if (states.every((state) => state.idleWaitSubscriptions.length > 0)) {
				resolve();
				return;
			}
			if (Date.now() - started > deadlineMs) {
				reject(new Error("subscriptions were never registered"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

function captureRuntime(now = Date.now) {
	const delivered: Array<{ content: string; deliverAs: string }> = [];
	const waiters: Array<() => void> = [];
	const runtime = new YieldingWaitRuntime({
		registry: new YieldingWaitRegistry(),
		deliver: (message) => {
			delivered.push({ content: message.content, deliverAs: message.deliverAs });
			waiters.shift()?.();
		},
		isRunIdle: () => true,
		now,
		createId: () => `wait-${delivered.length + 1}`,
	});
	return {
		runtime,
		delivered,
		nextDelivery: () =>
			new Promise<void>((resolve) => {
				if (delivered.length > 0) resolve();
				else waiters.push(resolve);
			}),
	};
}

const idleTransport = {
	probeEndpoint: (socketPath: string) => probeMemberEndpoint(socketPath),
	requestIdleWait: async (
		endpoint: string,
		memberLabel: string,
		options: { timeoutSeconds: number; signal?: AbortSignal },
	) => {
		const resolved = await resolveMemberEndpoint(endpoint);
		const command = { type: "member_idle_wait" as const, member: memberLabel };
		return sendMemberIdleWait(resolved, command, {
			timeoutSeconds: options.timeoutSeconds,
			signal: options.signal,
		});
	},
};

function runtimeServer(
	socketPath: string,
	state: ReturnType<typeof createSocketState>,
	opts: { isIdle: () => boolean },
) {
	return createRpcServer(socketPath, (command, socket) => handleCommand(piStub(), state, command, socket));

	function piStub() {
		return {
			sendMessage: () => undefined,
			appendEntry: () => undefined,
		} as never;
	}
	void opts;
}

test("TASK-0077: mutual member-idle waits yield immediately and each resumes exactly once on real settle", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-yielding-idle-"));
	const aPath = path.join(root, "a.sock");
	const bPath = path.join(root, "b.sock");

	// --- Runtime A (Tony) ---
	const stateA = createSocketState();
	stateA.membershipRuntime = {
		getMembership: () =>
			joinedMembership({ name: "Tony", role: "lead", socketPath: aPath }, [
				{ name: "Kelly", role: "qa", socketPath: bPath },
			]),
	} as never;
	stateA.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "a", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const captureA = captureRuntime();
	// --- Runtime B (Kelly) ---
	const stateB = createSocketState();
	stateB.membershipRuntime = {
		getMembership: () =>
			joinedMembership({ name: "Kelly", role: "qa", socketPath: bPath }, [
				{ name: "Tony", role: "lead", socketPath: aPath },
			]),
	} as never;
	stateB.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "b", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const captureB = captureRuntime();

	const serverA = await runtimeServer(aPath, stateA, { isIdle: () => false });
	const serverB = await runtimeServer(bPath, stateB, { isIdle: () => false });
	t.after(async () => {
		await closeRpcServer(serverA);
		await closeRpcServer(serverB);
		await fs.rm(root, { recursive: true, force: true });
	});

	// Register the real tools with the real transport, as extension.ts does.
	const toolsA: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
	const toolsB: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
	registerWaitForMemberIdleTool(
		{ registerTool: (tool) => toolsA.push(tool as never) } as never,
		stateA,
		idleTransport,
		captureA.runtime,
	);
	registerWaitForMemberIdleTool(
		{ registerTool: (tool) => toolsB.push(tool as never) } as never,
		stateB,
		idleTransport,
		captureB.runtime,
	);
	const waitA = toolsA.find((tool) => tool.name === "wait_for_member_idle")!;
	const waitB = toolsB.find((tool) => tool.name === "wait_for_member_idle")!;

	// Both members wait on each other: each execute MUST return immediately
	// (the pre-fix behavior blocked until the deadline — mutual busy-wait
	// deadlock). The guard bounds the wait well under the 10s idle timeout.
	const resultA = await within(
		2_000,
		waitA.execute("id", { member: "Kelly" } as never),
		"A blocked instead of yielding",
	);
	const resultB = await within(
		2_000,
		waitB.execute("id", { member: "Tony" } as never),
		"B blocked instead of yielding",
	);
	assert.equal((resultA as { details: { yielded: boolean } }).details.yielded, true);
	assert.equal((resultB as { details: { yielded: boolean } }).details.yielded, true);
	// Fire-and-forget RPC registration is async; wait until both servers armed
	// their one-shot subscriptions before settling, so no terminal is lost.
	await within(2_000, waitForSubscriptions([stateA, stateB]), "subscriptions never registered");

	// Both runs settle through the real agent_settled path (emitIdleSettled).
	emitIdleSettled(stateA, { isIdle: () => true } as never);
	emitIdleSettled(stateB, { isIdle: () => true } as never);

	await within(2_000, captureA.nextDelivery(), "A never resumed after B settled");
	await within(2_000, captureB.nextDelivery(), "B never resumed after A settled");
	assert.equal(captureA.delivered.length, 1, "A resumes exactly once");
	assert.equal(captureB.delivered.length, 1, "B resumes exactly once");
	assert.match(captureA.delivered[0]!.content, /member-idle Kelly: became-idle/);
	assert.match(captureB.delivered[0]!.content, /member-idle Tony: became-idle/);
	assert.equal(captureA.delivered[0]!.deliverAs, "steer");
	assert.equal(captureB.delivered[0]!.deliverAs, "steer");
});

test("TASK-0080: request-outcome wait yields, stays parked through the internal idle, and resolves only at post-idle grace expiry", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-yielding-request-"));
	const targetPath = path.join(root, "target.sock");
	const sourcePath = path.join(root, "source.sock");

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
	targetState.memberRequestFlow = new MemberRequestFlow({
		transport: {
			open: async () => ({ close: () => undefined }),
			respond: async () => undefined,
		},
		resolveEndpoint: resolveMemberEndpoint,
	});
	const acceptedIntoContext: unknown[] = [];
	const targetServer = await createRpcServer(targetPath, (command, socket) =>
		handleCommand(
			{
				sendMessage: (message: unknown, options: unknown) => {
					acceptedIntoContext.push({ message, options });
				},
			} as never,
			targetState,
			command,
			socket,
		),
	);
	t.after(async () => {
		await closeRpcServer(targetServer);
		await fs.rm(root, { recursive: true, force: true });
	});

	// --- Source runtime: real flow + real wait tool + real capture runtime ---
	const sourceState = createSocketState();
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
		// Real grace: 1s post-idle grace, default hard safety (cleared on terminal).
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimeout: (handle) => clearTimeout(handle),
	});
	sourceState.memberRequestFlow = flow;
	sourceState.membershipRuntime = {
		getMembership: () =>
			joinedMembership({ name: "Tony", role: "lead", socketPath: sourcePath }, [
				{ name: "Kelly", role: "qa", socketPath: targetPath },
			]),
	} as never;
	sourceState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "source", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const capture = captureRuntime();
	const tools: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
	registerWaitForRequestOutcomeTool(
		{ registerTool: (tool) => tools.push(tool as never) } as never,
		sourceState,
		capture.runtime,
	);
	const wait = tools.find((tool) => tool.name === "wait_for_request_outcome")!;

	// Real send + accept, then the wait tool yields immediately.
	const accepted = await flow.sendMemberRequest({
		membership: sourceState.membershipRuntime.getMembership(),
		member: "Kelly",
		message: "Deliver X",
		timeoutSeconds: 1,
	});
	assert.equal(accepted.requestId, "request-real-1");
	assert.equal(acceptedIntoContext.length, 1, "target must accept the request into model context");

	const result = await within(2_000, wait.execute("id", {} as never), "wait blocked instead of yielding");
	assert.equal((result as { details: { yielded: boolean } }).details.yielded, true);

	// Target reaches the real agent_settled path without any Response. The
	// internal member.request.idle notification arms the source grace; idle is
	// NONTERMINAL so the wait must stay parked (no delivery yet).
	emitIdleSettled(targetState, { isIdle: () => true } as never);
	await within(
		2_000,
		(async () => {
			for (;;) {
				if (flow.registry.getOutbound("request-real-1")?.idleArmed) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		})(),
		"idle never armed the source grace",
	);
	assert.equal(flow.registry.outboundCount(), 1, "idle must be nonterminal: wait stays parked");
	assert.equal(capture.delivered.length, 0, "idle alone must never resume the wait");

	// Post-idle grace expires without a Response -> terminal resume.
	await within(5_000, capture.nextDelivery(), "source never resumed at post-idle grace expiry");
	assert.equal(capture.delivered.length, 1, "request outcome resumes exactly once");
	assert.match(capture.delivered[0]!.content, /request-outcome request-real-1: timeout:response-after-idle/);
	assert.equal(flow.registry.outboundCount(), 0);
});
