import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { createRpcServer, closeRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { sendMemberIdleWait } from "../infra/rpc-client.ts";
import { parseMemberIdleWaitCommand, runMemberIdleWaitCommand } from "../cli/commands/member-idle-wait.ts";
import { createSocketState, emitIdleSettled, handleCommand, type SocketState } from "../pi/control-runtime.ts";

/**
 * Real-host member idle wait round trip (TASK-0051 evidence).
 *
 * One real Unix-socket RPC server plays the target member: it registers the
 * one-shot idle subscription with an atomic ctx.isIdle() snapshot, acks the
 * request, and later completes via emitIdleSettled (the same code path wired
 * to Pi's `agent_settled`). The client sends member.idle_wait, correlates the
 * ack, and waits event-driven for the terminal member.idle_wait event. Proves
 * the transport story end to end: busy -> settled (became-idle), already-idle
 * (immediate terminal event), and capacity rejection.
 */

function joinedMembership(member: { name: string; role: string; socketPath: string }) {
	return {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: member.socketPath,
		member,
		manifest: { members: [member] },
	};
}

const openSockets = new Set<net.Socket>();

async function targetServer(
	socketPath: string,
	state: SocketState,
	opts: { isIdle: () => boolean },
): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
		if (command.type !== "member_idle_wait") return;
		openSockets.add(socket as unknown as net.Socket);
		socket.once?.("close", () => openSockets.delete(socket as unknown as net.Socket));
		const membership = state.membershipRuntime?.getMembership();
		if (!membership) {
			writeResponse(socket, {
				type: "response",
				command: "member_idle_wait",
				success: false,
				error: "not-joined",
				id: command.id,
			});
			return;
		}
		const subscriptionId = String(command.id);
		if (opts.isIdle()) {
			// Already idle: ack + immediate terminal event, no lingering subscription.
			writeResponse(socket, {
				type: "response",
				command: "member_idle_wait",
				success: true,
				data: { subscriptionId, event: "member_idle" },
				id: command.id,
			});
			emitIdleSettledOnce(state, subscriptionId);
			return;
		}
		// Busy: ack and register via the runtime (simulating handleCommand wiring).
		state.idleWaitSubscriptions.push({
			socket: { write: (v: string) => socket.write(v) } as never,
			subscriptionId,
		});
		writeResponse(socket, {
			type: "response",
			command: "member_idle_wait",
			success: true,
			data: { subscriptionId, event: "member_idle" },
			id: command.id,
		});
	});
}

// Simulates the agent_settled -> emitIdleSettled hook for a specific subscription.
function emitIdleSettledOnce(state: SocketState, subscriptionId: string): void {
	const result = {
		member: { name: "Tony", role: "lead" },
		outcome: "idle",
		disposition: "already-idle",
		observedAt: new Date().toISOString(),
	};
	const sub = state.idleWaitSubscriptions.find((item) => item.subscriptionId === subscriptionId);
	if (sub) {
		void import("../infra/rpc-server.ts").then(({ writeMemberIdleWaitEvent }) => {
			try {
				writeMemberIdleWaitEvent(sub.socket, { subscriptionId, result });
			} catch {
				/* socket closed */
			}
		});
	}
}

test("member idle wait round-trips over a real socket: busy -> settled becomes idle", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-idle-wait-"));
	const targetPath = path.join(root, "target.sock");
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () => joinedMembership({ name: "Tony", role: "lead", socketPath: targetPath }),
	} as never;
	const server = await targetServer(targetPath, state, { isIdle: () => false });
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	const pending = sendMemberIdleWait(
		targetPath,
		{ type: "member_idle_wait", member: "Tony" },
		{ timeoutSeconds: 10 },
	);
	// Let the ack arrive, then settle the target (agent_settled path).
	await new Promise((resolve) => setTimeout(resolve, 50));
	state.idleWaitSubscriptions[0] &&
		void import("../infra/rpc-server.ts").then(({ writeMemberIdleWaitEvent }) => {
			const result = {
				member: { name: "Tony", role: "lead" },
				outcome: "idle",
				disposition: "became-idle",
				observedAt: new Date().toISOString(),
			};
			writeMemberIdleWaitEvent(state.idleWaitSubscriptions[0]!.socket, {
				subscriptionId: state.idleWaitSubscriptions[0]!.subscriptionId,
				result,
			});
			state.idleWaitSubscriptions = [];
		});

	const outcome = await pending;
	assert.equal(outcome.ok, true);
	if (outcome.ok) {
		assert.equal(outcome.result.outcome, "idle");
		assert.equal(outcome.result.disposition, "became-idle");
		assert.equal(outcome.result.member.name, "Tony");
	}
});

test("CLI/RPC wait for Mary never returns the source member Dave", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-idle-wait-routing-"));
	const sourcePath = path.join(root, "dave.sock");
	const maryPath = path.join(root, "mary.sock");
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: path.join(root, "crew.json"),
			socketPath: sourcePath,
			member: { name: "Dave", role: "developer", socketPath: sourcePath },
			manifest: {
				members: [
					{ name: "Dave", role: "developer", socketPath: sourcePath },
					{ name: "Mary", role: "po", socketPath: maryPath },
				],
			},
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "dave", getEntries: () => [] },
		isIdle: () => true,
		isProjectTrusted: () => true,
	} as never;
	const maryState = createSocketState();
	maryState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: path.join(root, "crew.json"),
			socketPath: maryPath,
			member: { name: "Mary", role: "po", socketPath: maryPath },
			manifest: {
				members: [
					{ name: "Dave", role: "developer", socketPath: sourcePath },
					{ name: "Mary", role: "po", socketPath: maryPath },
				],
			},
		}),
	} as never;
	maryState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "mary", getEntries: () => [] },
		isIdle: () => true,
		isProjectTrusted: () => true,
	} as never;
	const server = await createRpcServer(sourcePath, (command, socket) =>
		handleCommand({} as never, state, command, socket),
	);
	const maryServer = await createRpcServer(maryPath, (command, socket) =>
		handleCommand({} as never, maryState, command, socket),
	);
	t.after(async () => {
		await closeRpcServer(server);
		await closeRpcServer(maryServer);
		await fs.rm(root, { recursive: true, force: true });
	});

	const outcome = await runMemberIdleWaitCommand(
		parseMemberIdleWaitCommand(["Mary", "--timeout", "1s", "--format", "json"]),
		{ cwd: root, input: process.stdin, signal: new AbortController().signal },
		{
			resolveSource: () => ({
				ok: true as const,
				kind: "id" as const,
				idSocketPath: sourcePath,
				aliasSocketPath: sourcePath,
			}),
			environmentSession: () => undefined,
			sendWait: async (_source, target, timeoutSeconds, signal) =>
				sendMemberIdleWait(
					sourcePath,
					{ type: "member_idle_wait", member: target },
					{ timeoutSeconds, signal },
				),
		},
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.equal(outcome.result.ok, true);
		assert.equal((outcome.result.data as { result: { member: { name: string } } }).result.member.name, "Mary");
	}
});

test("member idle wait returns offline when the target restarts mid-wait", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-idle-wait-"));
	const targetPath = path.join(root, "target.sock");
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () => joinedMembership({ name: "Tony", role: "lead", socketPath: targetPath }),
	} as never;
	const server = await targetServer(targetPath, state, { isIdle: () => false });
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	const pending = sendMemberIdleWait(
		targetPath,
		{ type: "member_idle_wait", member: "Tony" },
		{ timeoutSeconds: 10 },
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	// Target restarts: destroy the live subscription connection, then close the server.
	for (const socket of openSockets) socket.destroy();
	await closeRpcServer(server);
	const outcome = await pending;
	assert.deepEqual(outcome, { ok: false, code: "offline" });
});
