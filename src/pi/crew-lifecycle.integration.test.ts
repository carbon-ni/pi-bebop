import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { createMembershipRuntime } from "../infra/membership-runtime.ts";
import { claimMemberEndpoint } from "../infra/member-endpoint.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { createRpcServer, closeRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { registerMemberTool } from "../tools/send-to-member.ts";
import { getLatestMembershipState, MEMBERSHIP_ENTRY_TYPE } from "./membership-context.ts";
import { restorePersistedMembership, releaseMembershipBeforeCleanup } from "./membership-lifecycle.ts";

async function socketServer(socketPath: string, messages: string[]): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
		if (command.type !== "send") return;
		messages.push(command.message);
		writeResponse(socket, {
			type: "response",
			command: "send",
			success: true,
			id: command.id,
			data: { delivered: true, mode: "steer" },
		});
	});
}

async function setupCrew() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-crew-integration-"));
	const bebop = path.join(root, ".pi", "bebop");
	const sockets = path.join(bebop, "sockets");
	const globals = path.join(root, "globals");
	await fs.mkdir(sockets, { recursive: true });
	await fs.mkdir(globals, { recursive: true });
	const manifestPath = path.join(bebop, "crew.json");
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 1,
			members: [
				{ name: "lead", role: "lead", socket: "sockets/lead.sock" },
				{ name: "developer", role: "developer", socket: "sockets/developer.sock" },
				{ name: "qa", role: "QA", socket: "sockets/qa.sock" },
			],
		}),
	);
	return {
		root,
		manifestPath,
		sockets,
		globals,
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("publishes exactly one real external endpoint for every supported layout", async (t) => {
	const layouts = [{ layout: "bebop" }, { layout: "crew" }];
	for (const { layout } of layouts) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `intray-${layout}-`));
		const manifestPath = path.join(root, ".pi", layout, "crew.json");
		const socketPath = path.join(root, ".pi", layout, "sockets", "lead.sock");
		const globalSocketPath = path.join(root, `${layout}-global.sock`);
		await fs.mkdir(path.dirname(manifestPath), { recursive: true });
		await fs.writeFile(
			manifestPath,
			JSON.stringify({ version: 1, members: [{ name: "lead", role: layout, socket: "sockets/lead.sock" }] }),
		);
		const server = await socketServer(globalSocketPath, []);
		t.after(async () => {
			await closeRpcServer(server);
			await fs.rm(root, { recursive: true, force: true });
		});
		await assert.rejects(() => fs.readlink(socketPath));
		const claimPaths: string[] = [];
		const runtime = createMembershipRuntime({
			loadManifest: (selected) => readTrustedCrewManifest(selected, root, () => true),
			claimEndpoint: async (endpoint, global, dependencies) => {
				claimPaths.push(endpoint);
				return claimMemberEndpoint(endpoint, global, dependencies);
			},
		});
		const joined = await runtime.join({ manifestPath, socketPath, globalSocketPath });
		assert.equal(joined.ok, true);
		assert.equal(joined.ok && joined.membership.manifestPath, manifestPath);
		assert.deepEqual(claimPaths, [socketPath]);
		assert.equal(claimPaths.length, 1);
		assert.equal(await fs.readlink(socketPath), globalSocketPath);
		const restoredRuntime = createMembershipRuntime({
			loadManifest: (selected) => readTrustedCrewManifest(selected, root, () => true),
		});
		const restored = await restorePersistedMembership({
			runtime: restoredRuntime,
			persisted: getLatestMembershipState([
				{ type: "custom", customType: MEMBERSHIP_ENTRY_TYPE, data: { active: true, socketPath, manifestPath } },
			]),
			startupSocketSelected: false,
			globalSocketPath,
			manifestPathForSocket: () => manifestPath,
			announce: () => undefined,
			reportFailure: assert.fail,
		});
		assert.equal(restored, true);
	}
});

test("crew lifecycle uses real manifest, symlink, RPC, and shutdown boundaries", async (t) => {
	const crew = await setupCrew();
	t.after(crew.cleanup);
	const manifest = await readTrustedCrewManifest(crew.manifestPath, crew.root, () => true);
	const leadGlobal = path.join(crew.globals, "lead.sock");
	const developerGlobal = path.join(crew.globals, "developer.sock");
	const qaGlobal = path.join(crew.globals, "qa.sock");
	const developerMessages: string[] = [];
	const qaMessages: string[] = [];
	const servers = await Promise.all([
		socketServer(developerGlobal, developerMessages),
		socketServer(qaGlobal, qaMessages),
	]);
	t.after(async () => Promise.all(servers.map(closeRpcServer)));
	const leadServer = await socketServer(leadGlobal, []);
	t.after(() => closeRpcServer(leadServer));

	// Startup adoption and real endpoint publication.
	const runtime = createMembershipRuntime({ loadManifest: async () => manifest });
	const leadPath = path.join(crew.sockets, "lead.sock");
	const joined = await runtime.join({
		manifestPath: crew.manifestPath,
		socketPath: leadPath,
		globalSocketPath: leadGlobal,
	});
	assert.equal(joined.ok, true);
	assert.equal(await fs.readlink(leadPath), leadGlobal);

	// Reload/resume restore reclaims the same live endpoint without changing identity.
	const persisted = {
		type: "custom",
		customType: MEMBERSHIP_ENTRY_TYPE,
		data: { active: true, socketPath: leadPath, manifestPath: crew.manifestPath },
	};
	const restoredRuntime = createMembershipRuntime({ loadManifest: async () => manifest });
	const restored = await restorePersistedMembership({
		runtime: restoredRuntime,
		persisted: getLatestMembershipState([persisted]),
		startupSocketSelected: false,
		globalSocketPath: leadGlobal,
		manifestPathForSocket: () => crew.manifestPath,
		announce: () => undefined,
		reportFailure: assert.fail,
	});
	assert.equal(restored, true);

	// New/fork branches carrying an inactive state do not reclaim an endpoint.
	assert.equal(
		getLatestMembershipState([{ ...persisted, data: { ...persisted.data, active: false } }])?.active,
		false,
	);
	const inactive = await restorePersistedMembership({
		runtime: createMembershipRuntime({ loadManifest: async () => manifest }),
		persisted: getLatestMembershipState([{ ...persisted, data: { ...persisted.data, active: false } }]),
		startupSocketSelected: false,
		globalSocketPath: leadGlobal,
		manifestPathForSocket: () => crew.manifestPath,
		announce: assert.fail,
		reportFailure: assert.fail,
	});
	assert.equal(inactive, false);

	// Publish both recipient endpoints as real crew members before role-aware messaging.
	await claimMemberEndpoint(path.join(crew.sockets, "developer.sock"), developerGlobal);
	await claimMemberEndpoint(path.join(crew.sockets, "qa.sock"), qaGlobal);

	// One lead orchestrator addresses both configured roles through public tool/RPC seams.
	const registered = new Map<string, any>();
	registerMemberTool(
		{
			registerTool(tool: any) {
				registered.set(tool.name, tool);
			},
		} as never,
		{
			membershipRuntime: restoredRuntime,
			context: { sessionManager: { getSessionId: () => "orchestrator", getSessionName: () => "lead" } },
		} as never,
	);
	const tool = registered.get("send_to_member");
	const send = (member: string, message: string) =>
		tool.execute("call", { member, message, wait_until: "off" }, undefined, undefined, undefined);
	assert.equal(await fs.readlink(path.join(crew.sockets, "developer.sock")), developerGlobal);
	assert.equal(await fs.readlink(path.join(crew.sockets, "qa.sock")), qaGlobal);
	const developerResult = await send("developer", "please implement fix");
	const qaResult = await send("qa", "please verify lifecycle");
	assert.equal(developerResult?.isError, undefined);
	assert.equal(qaResult?.isError, undefined);
	assert.match(
		developerMessages[0],
		/^please implement fix\n\n<sender_info>\{"sessionId":"orchestrator","sessionName":"lead"\}<\/sender_info>$/,
	);
	assert.match(
		qaMessages[0],
		/^please verify lifecycle\n\n<sender_info>\{"sessionId":"orchestrator","sessionName":"lead"\}<\/sender_info>$/,
	);

	// A live foreign owner is never stolen; a stale symlink is reclaimed.
	const foreign = path.join(crew.sockets, "developer.sock");
	await fs.unlink(foreign);
	await fs.symlink(qaGlobal, foreign);
	await assert.rejects(() => claimMemberEndpoint(foreign, developerGlobal), { code: "live-foreign" });
	await fs.unlink(foreign);
	await fs.symlink(path.join(crew.globals, "gone.sock"), foreign);
	await claimMemberEndpoint(foreign, developerGlobal);
	assert.equal(await fs.readlink(foreign), developerGlobal);

	// Shutdown releases only the endpoint still owned by the current global socket.
	await releaseMembershipBeforeCleanup({
		hasMembership: true,
		leave: () => restoredRuntime.leave(),
		cleanup: async () => undefined,
		reportFailure: assert.fail,
	});
	await releaseMembershipBeforeCleanup({
		hasMembership: true,
		leave: () => runtime.leave(),
		cleanup: async () => undefined,
		reportFailure: assert.fail,
	});
	assert.equal(
		await fs.lstat(path.join(crew.sockets, "developer.sock")).then(
			() => true,
			() => false,
		),
		true,
	); // lead shutdown cannot remove another endpoint owner
	assert.equal(
		await fs.lstat(leadPath).then(
			() => true,
			() => false,
		),
		false,
	);
	await sendRpcCommand(qaGlobal, { type: "send", message: "boundary probe", mode: "steer" }, { timeout: 1000 });
});
