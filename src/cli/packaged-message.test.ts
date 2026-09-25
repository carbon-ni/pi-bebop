import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as net from "node:net";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "../pi/control-runtime.ts";
import { sendRpcCommand, sendMemberRequest } from "../infra/rpc-client.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";

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
	readonly targetDeliveries: Array<{ content: string; options: { deliverAs?: string; triggerTurn?: boolean } }>;
	readonly targetEntries: unknown[];
	readonly sourceEntries: unknown[];
	readonly setTargetIdle: (value: boolean) => void;
	readonly setTargetCompacting: (value: boolean) => void;
	readonly settleTargetCompaction: () => void;
	readonly getTargetAbortCount: () => number;
	readonly sourceFlow: MemberRequestFlow;
	readonly targetFlow: MemberRequestFlow;
	close(): Promise<void>;
}

async function startSessions(t: test.TestContext): Promise<Sessions> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "bebop-packaged-message-"));
	const controlDir = path.join(root, ".pi", "bebop");
	await fs.mkdir(controlDir, { recursive: true });
	const sourceSocket = path.join(controlDir, "source-session-1.sock");
	const targetSocket = path.join(controlDir, "target.sock");
	const targetMessages: string[] = [];
	const targetDeliveries: Array<{ content: string; options: { deliverAs?: string; triggerTurn?: boolean } }> = [];
	const targetEntries: unknown[] = [];
	const sourceEntries: unknown[] = [];
	let targetIdle = false;
	let targetCompacting = false;
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
		isCompacting: () => targetCompacting,
		abort: () => {
			targetAbortCount += 1;
		},
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const targetFlow = new MemberRequestFlow({
		resolveEndpoint: async (endpoint) => endpoint,
		transport: { open: async () => ({ close: () => undefined }), respond: async () => undefined },
	});
	targetState.memberRequestFlow = targetFlow;
	const targetPi = {
		sendMessage: (customMessage: { content: string }, options: { deliverAs?: string; triggerTurn?: boolean }) => {
			targetMessages.push(customMessage.content);
			targetDeliveries.push({ content: customMessage.content, options });
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
	const sourceFlow = new MemberRequestFlow({
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
	sourceState.memberRequestFlow = sourceFlow;
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
		targetDeliveries,
		targetEntries,
		sourceEntries,
		setTargetIdle: (value) => {
			targetIdle = value;
		},
		setTargetCompacting: (value) => {
			targetCompacting = value;
		},
		settleTargetCompaction: () => {
			targetCompacting = false;
			emitIdleSettled(targetState, targetState.context as never);
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

async function packagedMessage(
	envHome: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const artifact = path.resolve("dist/cli/main.js");
	const child = spawn(process.execPath, [artifact, ...args], {
		env: { ...process.env, HOME: envHome },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	return { code, stdout, stderr };
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
	assert.equal(sessions.targetFlow.listRequestSummaries("inbound").length, 0);
});

test("request flow uses persistent Unix channel and returns one correlated response", async (t) => {
	const sessions = await startSessions(t);
	const accepted = await sessions.sourceFlow.sendMemberRequest({
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
	const waited = sessions.sourceFlow.waitForRequestOutcome((update) => {
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
	const accepted = await sessions.sourceFlow.sendMemberRequest({
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
	assert.equal(sessions.targetFlow.listRequestSummaries("inbound").length, 1);
	sessions.sourceFlow.cancelRequest(accepted.requestId);
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(sessions.targetFlow.listRequestSummaries("inbound").length, 0);
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
	assert.deepEqual(
		sessions.targetDeliveries.map(({ options }) => options),
		[
			{ triggerTurn: true, deliverAs: "followUp" },
			{ triggerTurn: true, deliverAs: "steer" },
		],
	);
	assert.equal(sessions.getTargetAbortCount(), 0, "Follow-up and Redirect never abort the active target turn");
});

test("packaged Follow-up keeps followUp mode for idle and compacting targets", async (t) => {
	const sessions = await startSessions(t);
	sessions.setTargetIdle(true);
	const idle = await packagedMessage(sessions.root, [
		"member",
		"follow-up",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"idle follow-up",
		"--format",
		"json",
	]);
	assert.equal(idle.code, 0, idle.stdout);
	assert.equal(JSON.parse(idle.stdout).data.disposition, "direct");
	sessions.setTargetCompacting(true);
	const compacting = await packagedMessage(sessions.root, [
		"member",
		"follow-up",
		"Kelly",
		"--session",
		"source-session-1",
		"--message",
		"compacting follow-up",
		"--format",
		"json",
	]);
	assert.equal(compacting.code, 0, compacting.stdout);
	assert.equal(JSON.parse(compacting.stdout).data.disposition, "queued");
	assert.equal(sessions.targetDeliveries.length, 1, "compacting Follow-up must wait for compaction end");
	sessions.settleTargetCompaction();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(
		sessions.targetDeliveries.map(({ options }) => options),
		[
			{ triggerTurn: true, deliverAs: "followUp" },
			{ triggerTurn: true, deliverAs: "followUp" },
		],
	);
	assert.equal(sessions.getTargetAbortCount(), 0);
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
	assert.equal(outcome.stdout, "");
	assert.match(outcome.stderr, /unknown option '--wait'/);
	assert.equal(sessions.targetMessages.length, 0);
});
