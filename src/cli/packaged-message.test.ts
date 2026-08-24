import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as net from "node:net";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";

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
	close(): Promise<void>;
}

async function startSessions(t: test.TestContext): Promise<Sessions> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "bebop-packaged-message-"));
	const controlDir = path.join(root, ".pi", "bebop");
	await fs.mkdir(controlDir, { recursive: true });
	const sourceSocket = path.join(controlDir, "source-session-1.sock");
	const targetSocket = path.join(controlDir, "target.sock");
	const targetMessages: string[] = [];

	const targetState = createSocketState();
	targetState.server = {} as never;
	targetState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: targetSocket,
			member: { name: "Kelly", role: "qa", socketPath: targetSocket },
			manifest: { members: [{ name: "Kelly", role: "qa", socketPath: targetSocket }] },
		}),
	} as never;
	targetState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "target", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const targetPi = {
		sendMessage: (customMessage: { content: string }, _options: unknown) => {
			targetMessages.push(customMessage.content);
		},
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
		sessionManager: { getSessionId: () => "source", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const sourceServer = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand({} as never, sourceState, command, socket),
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
