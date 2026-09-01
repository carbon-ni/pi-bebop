import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sendMemberIdleWait, sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { probeMemberEndpoint } from "../infra/member-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "./control-runtime.ts";
import { registerWaitForMemberIdleTool } from "../tools/wait-for-member-idle.ts";

/**
 * TASK-0081 real two-runtime barrier matrix (no wall-clock sleeps).
 *
 * The blocking Member Idle Wait is wired exactly as extension.ts wires it:
 * real RPC client, real Unix-socket server running the real `handleCommand`
 * paths, and the real accepted-message wake seam. Proves the observable
 * delivery barriers:
 *
 *   - Follow-up accepted by Bebop -> wake listener claims message-received ->
 *     remote idle subscription cancel requested -> unchanged Follow-up
 *     submitted with deliverAs followUp -> wait tool execution completes.
 *   - Redirect accepted -> wake claims -> unchanged Redirect submitted with
 *     deliverAs steer (non-FIFO steering semantics preserved).
 *   - Target agent_settled -> became-idle without any message.
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

/** Await until the target server registered the one-shot subscription (bounded). */
function waitForSubscription(state: { idleWaitSubscriptions: Array<unknown> }, deadlineMs = 2_000): Promise<void> {
	const started = Date.now();
	return new Promise<void>((resolve, reject) => {
		const check = () => {
			if (state.idleWaitSubscriptions.length > 0) {
				resolve();
				return;
			}
			if (Date.now() - started > deadlineMs) {
				reject(new Error("subscription was never registered"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
}

/** Await until the target's subscription is released (bounded; socket-close propagation is async). */
function waitForNoSubscription(state: { idleWaitSubscriptions: Array<unknown> }, deadlineMs = 2_000): Promise<void> {
	const started = Date.now();
	return new Promise<void>((resolve, reject) => {
		const check = () => {
			if (state.idleWaitSubscriptions.length === 0) {
				resolve();
				return;
			}
			if (Date.now() - started > deadlineMs) {
				reject(new Error("subscription was never released"));
				return;
			}
			setTimeout(check, 10);
		};
		check();
	});
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

type CapturedMessage = { customType: string; content: string; options: { deliverAs?: string; triggerTurn?: boolean } };

function captureServer(socketPath: string, state: ReturnType<typeof createSocketState>, sent: CapturedMessage[]) {
	return createRpcServer(socketPath, (command, socket) =>
		handleCommand(
			{
				sendMessage: (message: unknown, options: unknown) => {
					const custom = message as { customType: string; content: string };
					sent.push({ customType: custom.customType, content: custom.content, options: options as never });
				},
				appendEntry: () => undefined,
			} as never,
			state,
			command,
			socket,
		),
	);
}

function waitingState(
	socketPath: string,
	self: { name: string; role: string },
	target: { name: string; role: string; socketPath: string },
) {
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () =>
			joinedMembership({ name: self.name, role: self.role, socketPath }, [
				{ name: target.name, role: target.role, socketPath: target.socketPath },
			]),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => self.name, getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	return state;
}

test.skip("TASK-0081 legacy: busy target Follow-up no longer queues under TASK-0145", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-wake-followup-"));
	const aPath = path.join(root, "a.sock");
	const bPath = path.join(root, "b.sock");
	const sentA: CapturedMessage[] = [];
	const stateA = waitingState(
		aPath,
		{ name: "Tony", role: "lead" },
		{ name: "Kelly", role: "qa", socketPath: bPath },
	);
	const stateB = waitingState(
		bPath,
		{ name: "Kelly", role: "qa" },
		{ name: "Tony", role: "lead", socketPath: aPath },
	);
	const serverA = await captureServer(aPath, stateA, sentA);
	const serverB = await captureServer(bPath, stateB, []);
	t.after(async () => {
		await closeRpcServer(serverA);
		await closeRpcServer(serverB);
		await fs.rm(root, { recursive: true, force: true });
	});

	// Tony (Lead) blocks waiting for Kelly's idle. Kelly is busy.
	const toolsA: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
	registerWaitForMemberIdleTool(
		{ registerTool: (tool) => toolsA.push(tool as never) } as never,
		stateA,
		idleTransport,
	);
	const waitA = toolsA.find((tool) => tool.name === "wait_for_member_idle")!;
	const pending = waitA.execute("id", { member: "Kelly" } as never) as Promise<{
		details: { result: { outcome: string } };
	}>;
	await within(2_000, waitForSubscription(stateB), "idle subscription never registered");

	// A Follow-up arrives for Tony: accepted by Bebop, wake claims BEFORE the
	// unchanged message is submitted.
	await sendRpcCommand(aPath, {
		type: "send",
		id: "w1",
		payload: { content: "wake up" },
		delivery: "follow_up",
	} as never);

	const result = await within(2_000, pending, "blocked wait never released by accepted Follow-up");
	assert.equal((result as { terminate?: boolean }).terminate, true);
	assert.equal(result.details.result.outcome, "message-received");
	assert.equal(sentA.length, 1, "unchanged message submitted exactly once");
	assert.equal(sentA[0]!.options.deliverAs, "followUp", "Follow-up keeps FIFO mode");
	await within(2_000, waitForNoSubscription(stateB), "remote idle subscription never cancelled on wake");
});

test.skip("TASK-0081 legacy: busy target Redirect wake scenario superseded by TASK-0145", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-wake-redirect-"));
	const aPath = path.join(root, "a.sock");
	const bPath = path.join(root, "b.sock");
	const sentA: CapturedMessage[] = [];
	const stateA = waitingState(
		aPath,
		{ name: "Tony", role: "lead" },
		{ name: "Kelly", role: "qa", socketPath: bPath },
	);
	const stateB = waitingState(
		bPath,
		{ name: "Kelly", role: "qa" },
		{ name: "Tony", role: "lead", socketPath: aPath },
	);
	const serverA = await captureServer(aPath, stateA, sentA);
	const serverB = await captureServer(bPath, stateB, []);
	t.after(async () => {
		await closeRpcServer(serverA);
		await closeRpcServer(serverB);
		await fs.rm(root, { recursive: true, force: true });
	});

	const toolsA: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
	registerWaitForMemberIdleTool(
		{ registerTool: (tool) => toolsA.push(tool as never) } as never,
		stateA,
		idleTransport,
	);
	const waitA = toolsA.find((tool) => tool.name === "wait_for_member_idle")!;
	const pending = waitA.execute("id", { member: "Kelly" } as never) as Promise<{
		details: { result: { outcome: string } };
	}>;
	await within(2_000, waitForSubscription(stateB), "idle subscription never registered");

	// A Redirect arrives for Tony: wake claims, steer semantics preserved.
	await sendRpcCommand(aPath, {
		type: "send",
		id: "w2",
		payload: { content: "redirect now" },
		delivery: "immediate",
	} as never);

	const result = await within(2_000, pending, "blocked wait never released by accepted Redirect");
	assert.equal((result as { terminate?: boolean }).terminate, true);
	assert.equal(result.details.result.outcome, "message-received");
	assert.equal(sentA.length, 1, "unchanged message submitted exactly once");
	assert.equal(sentA[0]!.options.deliverAs, "steer", "Redirect keeps non-FIFO steering");
});

test("TASK-0081: busy target -> agent_settled releases the blocked wait with became-idle (no message)", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-wake-settled-"));
	const aPath = path.join(root, "a.sock");
	const bPath = path.join(root, "b.sock");
	const sentA: CapturedMessage[] = [];
	const stateA = waitingState(
		aPath,
		{ name: "Tony", role: "lead" },
		{ name: "Kelly", role: "qa", socketPath: bPath },
	);
	const stateB = waitingState(
		bPath,
		{ name: "Kelly", role: "qa" },
		{ name: "Tony", role: "lead", socketPath: aPath },
	);
	const serverA = await captureServer(aPath, stateA, sentA);
	const serverB = await captureServer(bPath, stateB, []);
	t.after(async () => {
		await closeRpcServer(serverA);
		await closeRpcServer(serverB);
		await fs.rm(root, { recursive: true, force: true });
	});

	const toolsA: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
	registerWaitForMemberIdleTool(
		{ registerTool: (tool) => toolsA.push(tool as never) } as never,
		stateA,
		idleTransport,
	);
	const waitA = toolsA.find((tool) => tool.name === "wait_for_member_idle")!;
	const pending = waitA.execute("id", { member: "Kelly" } as never) as Promise<{
		details: { result: { outcome: string; disposition?: string } };
	}>;
	await within(2_000, waitForSubscription(stateB), "idle subscription never registered");

	// Kelly's Pi settles through the real agent_settled path.
	emitIdleSettled(stateB, { isIdle: () => true } as never);

	const result = await within(2_000, pending, "blocked wait never released by target settle");
	assert.equal((result as { terminate?: boolean }).terminate, false);
	assert.equal(result.details.result.outcome, "idle");
	assert.equal(result.details.result.disposition, "became-idle");
	assert.equal(sentA.length, 0, "no message involved");
});
