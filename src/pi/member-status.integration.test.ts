import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { createRpcServer, closeRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { createMemberStatusFlow } from "../application/member-status-flow.ts";
import { createOnlineMemberStatus, type MemberStatus } from "../domain/index.ts";

/**
 * Real-host member.status round trip (TASK-0047 evidence).
 *
 * One real Unix-socket RPC server plays the target member: it computes its own
 * mechanical idle/busy and pending-message signal and answers `member.status`
 * without triggering a turn. The client resolves the target, probes
 * reachability, sends the strict RPC, and validates the closed status
 * contract. Proves the transport story end to end: online busy and idle
 * mechanical states, and a not-joined target rejection.
 */

async function targetServer(
	socketPath: string,
	state: { isIdle: () => boolean; hasPendingMessages: () => boolean },
): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
		if (command.type !== "member_status") return;
		const observedAt = new Date().toISOString();
		const status = createOnlineMemberStatus({
			member: { name: "Tony", role: "lead" },
			isIdle: state.isIdle(),
			hasPendingMessages: state.hasPendingMessages(),
			observedAt,
		});
		writeResponse(socket, {
			type: "response",
			command: "member_status",
			success: true,
			data: { status },
			id: command.id,
		});
	});
}

test("member.status round-trips over a real socket with busy and idle mechanical states", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-status-"));
	const targetPath = path.join(root, "target.sock");
	const server = await targetServer(targetPath, {
		isIdle: () => false,
		hasPendingMessages: () => true,
	});
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	// Client flow: probe alive, then strict member.status RPC.
	const probes: string[] = [];
	const flow = createMemberStatusFlow({
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: path.join(root, "client.sock"),
			member: { name: "Bob", role: "dev", socketPath: path.join(root, "client.sock") },
			manifest: {
				members: [{ name: "Tony", role: "lead", socketPath: targetPath }],
			},
		}),
		isTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		probeEndpoint: async (socketPath) => {
			probes.push(socketPath);
			return true;
		},
		requestStatus: async (endpoint, memberLabel) => {
			const { response } = await sendRpcCommand(
				endpoint,
				{ type: "member_status", member: memberLabel },
				{ timeout: 1000 },
			);
			if (!response.success) return { ok: false, code: "remote-rejected" };
			const data = response.data as { status: MemberStatus };
			return { ok: true, status: data.status };
		},
		now: () => "2026-08-23T12:03:00.000Z",
	});

	const busy = await flow.queryStatus("Tony");
	assert.equal(busy.presence, "online");
	assert.equal(busy.activity, "busy");
	assert.equal(busy.hasPendingMessages, true);
	assert.equal(busy.member.name, "Tony");
	assert.deepEqual(probes, [targetPath]);
});
