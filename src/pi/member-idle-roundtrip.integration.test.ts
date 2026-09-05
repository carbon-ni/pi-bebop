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
import { registerWaitForMemberIdleTool } from "../tools/wait-for-member-idle.ts";

/** TASK-0081 real two-runtime Member Idle Wait round trip. */

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

/** Await until both servers registered their one-shot subscriptions. */
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

const idleTransport = {
	probeEndpoint: (socketPath: string) => probeMemberEndpoint(socketPath),
	requestIdleWait: async (
		endpoint: string,
		memberLabel: string,
		options: { timeoutSeconds: number; signal?: AbortSignal },
	) => {
		const resolved = await resolveMemberEndpoint(endpoint);
		const command = { type: "member_idle_wait" as const, member: memberLabel, forwarded: true };
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

test("TASK-0081: mutual member-idle waits BLOCK and each returns became-idle exactly once on real settle", async (t) => {
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
	);
	registerWaitForMemberIdleTool(
		{ registerTool: (tool) => toolsB.push(tool as never) } as never,
		stateB,
		idleTransport,
	);
	const waitA = toolsA.find((tool) => tool.name === "wait_for_member_idle")!;
	const waitB = toolsB.find((tool) => tool.name === "wait_for_member_idle")!;

	// Both members wait on each other: each execute BLOCKS (never yields) and
	// releases only when the target settles or an accepted message/abort/timeout
	// arrives. The bounded timeout is the fallback, so this never deadlocks.
	const pendingA = waitA.execute("id", { member: "Kelly" } as never);
	const pendingB = waitB.execute("id", { member: "Tony" } as never);
	// Fire-and-forget RPC registration is async; wait until both servers armed
	// their one-shot subscriptions before settling, so no terminal is lost.
	await within(2_000, waitForSubscriptions([stateA, stateB]), "subscriptions never registered");

	// Both runs settle through the real agent_settled path (emitIdleSettled).
	emitIdleSettled(stateA, { isIdle: () => true } as never);
	emitIdleSettled(stateB, { isIdle: () => true } as never);

	const resultA = (await within(2_000, pendingA, "A never released after B settled")) as {
		details: { result: { outcome: string; disposition?: string } };
	};
	const resultB = (await within(2_000, pendingB, "B never released after A settled")) as {
		details: { result: { outcome: string; disposition?: string } };
	};
	assert.equal(resultA.details.yielded, undefined, "blocking wait must not yield");
	assert.equal(resultB.details.yielded, undefined, "blocking wait must not yield");
	assert.equal(resultA.details.result.outcome, "idle");
	assert.equal(resultA.details.result.disposition, "became-idle");
	assert.equal(resultB.details.result.outcome, "idle");
	assert.equal(resultB.details.result.disposition, "became-idle");
});
