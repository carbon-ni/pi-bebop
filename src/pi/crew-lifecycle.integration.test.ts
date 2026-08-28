import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { execFileSync } from "node:child_process";

import { createMembershipRuntime } from "../infra/membership-runtime.ts";
import { claimMemberEndpoint } from "../infra/member-endpoint.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { createRpcServer, closeRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";
import { registerSendFollowUpTool, registerRedirectMemberTool } from "../tools/index.ts";
import { getLatestMembershipState, MEMBERSHIP_ENTRY_TYPE } from "./membership-context.ts";
import { restorePersistedMembership, releaseMembershipBeforeCleanup } from "./membership-lifecycle.ts";
import { createSocketState, refreshSessionAliases } from "./control-runtime.ts";
import { getAliasPath, getSocketPath } from "../infra/intray-paths.ts";
import { ensureControlDir, removeAliasesForSocket, removeSocket } from "../infra/control-store.ts";
import { createSessionNameController } from "./session-name.ts";

async function socketServer(socketPath: string, messages: string[]): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
		if (command.type !== "send") return;
		messages.push(command.payload.content);
		writeResponse(socket, {
			type: "response",
			command: "send",
			success: true,
			id: command.id,
			data: { deliveryId: `delivery-${command.id}`, disposition: "direct" },
		});
	});
}

const sessionMembership = (name: string, role = "qa") => ({
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: `/project/.pi/bebop/sockets/${name.toLowerCase()}.sock`,
	globalSocketPath: "/home/.pi/intray/session.sock",
	member: { name, role, socketPath: `/project/.pi/bebop/sockets/${name.toLowerCase()}.sock` },
	manifest: { members: [] },
});

function fakeSession(initial?: string) {
	let name: string | undefined = initial;
	return {
		host: {
			getSessionName: () => name,
			setSessionName: (next: string) => {
				name = next || undefined;
			},
			appendEntry: () => undefined,
		},
		get name() {
			return name;
		},
	};
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
	const toolApi = {
		registerTool(tool: any) {
			registered.set(tool.name, tool);
		},
	} as never;
	const toolState = {
		membershipRuntime: restoredRuntime,
		context: { sessionManager: { getSessionId: () => "orchestrator", getSessionName: () => "lead" } },
	} as never;
	const memberMessageDependencies = {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	};
	registerSendFollowUpTool(toolApi, toolState, memberMessageDependencies);
	registerRedirectMemberTool(toolApi, toolState, memberMessageDependencies);
	const tool = registered.get("send_follow_up");
	const send = (member: string, message: string) =>
		tool.execute("call", { member, message }, undefined, undefined, undefined);
	assert.equal(await fs.readlink(path.join(crew.sockets, "developer.sock")), developerGlobal);
	assert.equal(await fs.readlink(path.join(crew.sockets, "qa.sock")), qaGlobal);
	const developerResult = await send("developer", "please implement fix");
	const qaResult = await send("qa", "please verify lifecycle");
	assert.equal(developerResult?.isError, undefined);
	assert.equal(qaResult?.isError, undefined);
	assert.equal(developerMessages[0], "please implement fix");
	assert.equal(qaMessages[0], "please verify lifecycle");

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
	await sendRpcCommand(
		qaGlobal,
		{ type: "send", payload: { content: "boundary probe" }, delivery: "immediate" },
		{ timeout: 1000 },
	);
});

test("two live project fixtures auto-name Mary without a global alias and keep project aliases stable", async () => {
	await ensureControlDir();
	const originalCwd = process.cwd();
	const roots = await Promise.all(
		["a", "b"].map(async (suffix) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `task0127-project-${suffix}-`));
			await fs.writeFile(path.join(root, "README"), suffix);
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
			execFileSync("git", ["config", "user.email", "task0127@example.test"], { cwd: root });
			execFileSync("git", ["config", "user.name", "TASK-0127"], { cwd: root });
			execFileSync("git", ["add", "README"], { cwd: root });
			execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
			return root;
		}),
	);
	const states = ["task0127-project-a", "task0127-project-b"].map((id) => {
		const state = createSocketState();
		state.server = {} as never;
		state.socketPath = getSocketPath(`${id}-${process.pid}`);
		const session = fakeSession();
		state.sessionNameController = createSessionNameController(session.host);
		state.sessionNameController.syncMembership(sessionMembership("Mary"));
		state.sessionNameController.observeChange("Mary");
		return {
			state,
			ctx: {
				sessionManager: { getSessionId: () => `${id}-${process.pid}`, getSessionName: () => session.name },
			} as never,
		};
	});
	try {
		await fs.rm(getAliasPath("Mary"), { force: true });
		for (let index = 0; index < roots.length; index += 1) {
			process.chdir(roots[index]!);
			await refreshSessionAliases(states[index]!.state, states[index]!.ctx);
			assert.equal(states[index]!.state.aliases.length, 1);
			assert.match(
				states[index]!.state.aliases[0]!,
				new RegExp(`^intra-${path.basename(roots[index]!)}-branch-main-1$`),
			);
		}
		assert.equal(
			await fs.lstat(getAliasPath("Mary")).then(
				() => true,
				() => false,
			),
			false,
		);

		const first = states[0]!;
		first.state.sessionNameController!.syncMembership(null); // leave/stop/shutdown clears auto-owned display metadata
		first.state.sessionNameController!.observeChange(undefined); // consume the internal clear event
		process.chdir(roots[0]!);
		await refreshSessionAliases(first.state, first.ctx);
		assert.equal(
			await fs.lstat(getAliasPath("Mary")).then(
				() => true,
				() => false,
			),
			false,
		);
		assert.match(first.state.aliases[0]!, new RegExp(`^intra-${path.basename(roots[0]!)}-branch-main-1$`));
		first.state.sessionNameController!.syncMembership(sessionMembership("Kelly", "developer")); // rejoin/replacement
		first.state.sessionNameController!.observeChange("Kelly");
		await refreshSessionAliases(first.state, first.ctx);
		assert.match(first.state.aliases[0]!, new RegExp(`^intra-${path.basename(roots[0]!)}-branch-main-1$`));
		const stableAlias = first.state.aliases[0]!;
		await removeAliasesForSocket(first.state.socketPath); // stop/shutdown removes every alias owned by this socket
		assert.equal(
			await fs.lstat(getAliasPath(stableAlias)).then(
				() => true,
				() => false,
			),
			false,
		);

		for (let index = 0; index < roots.length; index += 1) {
			process.chdir(roots[index]!);
			await refreshSessionAliases(states[index]!.state, states[index]!.ctx);
			assert.match(
				states[index]!.state.aliases[0]!,
				new RegExp(`^intra-${path.basename(roots[index]!)}-branch-main-1$`),
			);
		}
	} finally {
		process.chdir(originalCwd);
		await Promise.all(
			states.map(({ state }) =>
				removeAliasesForSocket(state.socketPath).then(() => removeSocket(state.socketPath)),
			),
		);
		await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
		await fs.rm(getAliasPath("Mary"), { force: true });
	}
});
