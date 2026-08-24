import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as net from "node:net";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";
import { sendRpcCommand, sendMemberRequest } from "../infra/rpc-client.ts";
import { CrewUpdateFlow } from "../application/crew-update-flow.ts";

/**
 * TASK-0062 packaged proof: the built dist CLI delivers a follow-up and a
 * redirect to a joined target through the real production dispatcher and real
 * temporary Unix control sockets — no mocked CLI handler, dispatcher,
 * renderer, or RPC codec. Accepted-delivery semantics: the acknowledgement
 * carries identity, deliveryId, and disposition; nothing waits for a reply.
 */

interface Sessions {
	readonly root: string;
	readonly sourceSocket: string;
	readonly targetSocket: string;
	readonly sourceServer: net.Server;
	readonly targetServer: net.Server;
	readonly targetMessages: string[];
	readonly targetEntries: unknown[];
	readonly sourceEntries: unknown[];
	readonly setTargetIdle: (value: boolean) => void;
	readonly getTargetAbortCount: () => number;
	readonly sourceFlow: CrewUpdateFlow;
	readonly targetFlow: CrewUpdateFlow;
	close(): Promise<void>;
}

async function startSessions(t: test.TestContext): Promise<Sessions> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "bebop-packaged-message-"));
	const controlDir = path.join(root, ".pi", "bebop");
	await fs.mkdir(controlDir, { recursive: true });
	const sourceSocket = path.join(controlDir, "source-session-1.sock");
	const targetSocket = path.join(controlDir, "target.sock");
	const targetMessages: string[] = [];
	const targetEntries: unknown[] = [];
	const sourceEntries: unknown[] = [];
	let targetIdle = false;
	let targetAbortCount = 0;

	const targetState = createSocketState();
	targetState.server = {} as never;
	targetState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: targetSocket,
			member: { name: "Kelly", role: "qa", socketPath: targetSocket },
			manifest: {
				members: [
					{ name: "Tony", role: "lead", socketPath: sourceSocket },
					{ name: "Kelly", role: "qa", socketPath: targetSocket },
				],
			},
		}),
	} as never;
	targetState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "target", getSessionName: () => null, getEntries: () => targetEntries },
		isIdle: () => targetIdle,
		abort: () => {
			targetAbortCount += 1;
		},
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const targetFlow = new CrewUpdateFlow({
		resolveEndpoint: async (endpoint) => endpoint,
		transport: { open: async () => ({ close: () => undefined }), respond: async () => undefined },
	});
	targetState.crewUpdateFlow = targetFlow;
	const targetPi = {
		sendMessage: (customMessage: { content: string }, _options: unknown) => {
			targetMessages.push(customMessage.content);
		},
		appendEntry: (customType: string, data: unknown) => targetEntries.push({ type: "custom", customType, data }),
	} as never;
	const targetServer = await createRpcServer(targetSocket, (command, socket) =>
		handleCommand(targetPi, targetState, command, socket),
	);

	const sourceState = createSocketState();
	sourceState.server = {} as never;
	sourceState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: sourceSocket,
			member: { name: "Tony", role: "lead", socketPath: sourceSocket },
			manifest: {
				members: [
					{ name: "Tony", role: "lead", socketPath: sourceSocket },
					{ name: "Kelly", role: "qa", socketPath: targetSocket },
				],
			},
		}),
	} as never;
	sourceState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "source", getSessionName: () => null, getEntries: () => sourceEntries },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const sourceFlow = new CrewUpdateFlow({
		resolveEndpoint: async (endpoint) => endpoint,
		transport: {
			open: (endpoint, command, options) =>
				sendMemberRequest(endpoint, command, {
					timeout: options.timeoutMs,
					signal: options.signal,
					onUpdate: options.onUpdate,
				}),
			respond: async () => undefined,
		},
	});
	sourceState.crewUpdateFlow = sourceFlow;
	const sourcePi = {
		appendEntry: (customType: string, data: unknown) => sourceEntries.push({ type: "custom", customType, data }),
	};
	const sourceServer = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand(sourcePi as never, sourceState, command, socket),
	);

	t.after(async () => {
		await closeRpcServer(sourceServer);
		await closeRpcServer(targetServer);
		await fs.rm(root, { recursive: true, force: true });
	});
	return {
		root,
		sourceSocket,
		targetSocket,
		sourceServer,
		targetServer,
		targetMessages,
		targetEntries,
		sourceEntries,
		setTargetIdle: (value) => {
			targetIdle = value;
		},
		getTargetAbortCount: () => targetAbortCount,
		sourceFlow,
		targetFlow,
		close: async () => {
			await closeRpcServer(sourceServer);
			await closeRpcServer(targetServer);
		},
	};
}

async function packagedMessage(envHome: string, args: string[]): Promise<{ code: number; stdout: string }> {
	const artifact = path.resolve("dist/cli/main.js");
	const child = spawn(process.execPath, [artifact, ...args], {
		env: { ...process.env, HOME: envHome },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	return { code, stdout };
}

test("request transport rejects forged origin before inbound state or Pi visibility", async (t) => {
	const sessions = await startSessions(t);
	await assert.rejects(
		() =>
			sendRpcCommand(sessions.targetSocket, {
				type: "member_request",
				requestId: "forged-1",
				payload: { content: "forged", origin: { kind: "crew", name: "Mallory", role: "lead" } },
				timeoutSeconds: 300,
			}),
		(error: unknown) => error instanceof Error && /invalid-origin/.test(error.message),
	);
	assert.deepEqual(sessions.targetMessages, []);
	assert.equal(sessions.targetFlow.registry.inboundCount(), 0);
});

test("request flow uses persistent Unix channel and returns one correlated response", async (t) => {
	const sessions = await startSessions(t);
	const accepted = await sessions.sourceFlow.requestMember({
		membership: {
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: sessions.sourceSocket,
			member: { name: "Tony", role: "lead", socketPath: sessions.sourceSocket },
			manifest: {
				members: [
					{ name: "Tony", role: "lead", socketPath: sessions.sourceSocket },
					{ name: "Kelly", role: "qa", socketPath: sessions.targetSocket },
				],
			},
		} as never,
		member: "Kelly",
		message: "Please review",
	});
	assert.match(accepted.requestId, /^request_/);
	await sessions.targetFlow.respondToMemberRequest({
		message: "Response received",
		member: { name: "Kelly", role: "qa" },
	});
	const updates: unknown[] = [];
	let resolveUpdate!: () => void;
	const updateArrived = new Promise<void>((resolve) => {
		resolveUpdate = resolve;
	});
	const waited = sessions.sourceFlow.waitForCrewUpdate((update) => {
		updates.push(update);
		resolveUpdate();
	});
	assert.equal(waited.ok, true);
	if (waited.ok && waited.kind === "waiting") await updateArrived;
	assert.equal(updates.length, 1);
	assert.equal((updates[0] as { kind: string }).kind, "response");
});

test("accepted request disconnect removes target inbound channel state", async (t) => {
	const sessions = await startSessions(t);
	const accepted = await sessions.sourceFlow.requestMember({
		membership: {
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: sessions.sourceSocket,
			member: { name: "Tony", role: "lead", socketPath: sessions.sourceSocket },
			manifest: {
				members: [
					{ name: "Tony", role: "lead", socketPath: sessions.sourceSocket },
					{ name: "Kelly", role: "qa", socketPath: sessions.targetSocket },
				],
			},
		} as never,
		member: "Kelly",
		message: "disconnect me",
	});
	assert.equal(sessions.targetFlow.registry.inboundCount(), 1);
	sessions.sourceFlow.cancelRequest(accepted.requestId);
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(sessions.targetFlow.registry.inboundCount(), 0);
});

test("packaged CLI delivers follow-up and redirect end to end with accepted dispositions", async (t) => {
	const sessions = await startSessions(t);

	const followUp = await packagedMessage(sessions.root, [
		"member",
		"follow-up",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"wrap up",
		"--format",
		"json",
	]);
	assert.equal(followUp.code, 0, followUp.stdout);
	const followData = JSON.parse(followUp.stdout);
	assert.equal(followData.status, "accepted");
	assert.equal(followData.data.member.name, "Kelly");
	assert.equal(followData.data.disposition, "queued");
	assert.match(followData.data.deliveryId, /^delivery-/);

	const redirect = await packagedMessage(sessions.root, [
		"member",
		"redirect",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"change course",
		"--format",
		"json",
	]);
	assert.equal(redirect.code, 0, redirect.stdout);
	const redirectData = JSON.parse(redirect.stdout);
	assert.equal(redirectData.status, "accepted");
	assert.equal(redirectData.data.disposition, "steered");

	// The target session received both structured messages in order.
	assert.equal(sessions.targetMessages.length, 2);
	assert.match(sessions.targetMessages[0]!, /wrap up/);
	assert.match(sessions.targetMessages[1]!, /change course/);
});

test("packaged CLI interrupt proves idle direct and busy best-effort recovery dispositions", async (t) => {
	const sessions = await startSessions(t);
	sessions.setTargetIdle(true);
	const idle = await packagedMessage(sessions.root, [
		"member",
		"interrupt",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"recover idle",
		"--format",
		"json",
	]);
	assert.equal(idle.code, 0, idle.stdout);
	assert.equal(JSON.parse(idle.stdout).data.disposition, "direct");
	assert.equal(sessions.getTargetAbortCount(), 0);
	assert.deepEqual(
		sessions.targetEntries.map((entry) => (entry as { data: { phase: string } }).data.phase),
		["pending", "handed-off"],
	);

	sessions.setTargetIdle(false);
	const busy = await packagedMessage(sessions.root, [
		"member",
		"interrupt",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"recover busy",
		"--format",
		"json",
	]);
	assert.equal(busy.code, 0, busy.stdout);
	assert.equal(JSON.parse(busy.stdout).data.disposition, "interrupt-requested");
	assert.equal(sessions.getTargetAbortCount(), 1);
});

test("packaged CLI focus set/status/clear/status round trips self-scoped durable state", async (t) => {
	const sessions = await startSessions(t);
	const set = await packagedMessage(sessions.root, [
		"member",
		"focus",
		"set",
		"--session",
		"source-session-1",
		"--format",
		"json",
		"--",
		"--blocked",
	]);
	assert.equal(set.code, 0, set.stdout);
	assert.equal(JSON.parse(set.stdout).status, "updated");
	const statusAfterSet = await sendRpcCommand(sessions.sourceSocket, {
		type: "member_status",
		member: "Tony",
		id: "status-focus-1",
	});
	assert.equal(statusAfterSet.response.success, true);
	assert.equal(
		(statusAfterSet.response.data as { status: { focus: { state: string; text?: string } } }).status.focus.text,
		"--blocked",
	);

	const clear = await packagedMessage(sessions.root, [
		"member",
		"focus",
		"clear",
		"--session",
		"source-session-1",
		"--format",
		"json",
	]);
	assert.equal(clear.code, 0, clear.stdout);
	assert.equal(JSON.parse(clear.stdout).status, "cleared");
	const statusAfterClear = await sendRpcCommand(sessions.sourceSocket, {
		type: "member_status",
		member: "Tony",
		id: "status-focus-2",
	});
	assert.equal(
		(statusAfterClear.response.data as { status: { focus: { state: string } } }).status.focus.state,
		"unspecified",
	);
	const unchanged = await packagedMessage(sessions.root, [
		"member",
		"focus",
		"clear",
		"--session",
		"source-session-1",
		"--format",
		"json",
	]);
	assert.equal(unchanged.code, 0, unchanged.stdout);
	assert.equal(JSON.parse(unchanged.stdout).status, "unchanged");
});

test("packaged CLI rejects a wait flag with accepted-only recovery and no delivery", async (t) => {
	const sessions = await startSessions(t);
	const outcome = await packagedMessage(sessions.root, [
		"member",
		"follow-up",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"x",
		"--wait",
		"response",
		"--format",
		"json",
	]);
	assert.equal(outcome.code, 2, outcome.stdout);
	assert.match(outcome.stdout, /accepted-delivery only/);
	assert.equal(sessions.targetMessages.length, 0);
});
