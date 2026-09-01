import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAssistantMessageEventStream,
	createProvider as createAiProvider,
	type AssistantMessage,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";
import { enqueueMemberInboxMessage } from "../application/member-inbox-message.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { registerSendFollowUpTool } from "../tools/send-follow-up.ts";
import { registerBroadcastToCrewTool } from "../tools/broadcast-to-crew.ts";
import bebopExtension from "../extension.ts";
import { createSocketState } from "./control-runtime.ts";
import { createModelDeliveryAdapter } from "./compaction-delivery.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const model: Model<"bebop-follow-up-fake"> = {
	id: "follow-up-fake-1",
	name: "Follow-up Fake",
	api: "bebop-follow-up-fake",
	provider: "bebop-follow-up-fake",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 1_000,
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createProvider(events: string[], releases: Array<Promise<void>>): Provider<"bebop-follow-up-fake"> {
	let calls = 0;
	return createAiProvider({
		id: model.provider,
		name: "Follow-up Fake Provider",
		models: [model],
		auth: {
			apiKey: {
				name: "test key",
				async login() {
					return { type: "api_key", key: "test" };
				},
				async resolve() {
					return { auth: { apiKey: "test" }, source: "integration test" };
				},
			},
		},
		api: {
			[model.api]: {
				streamSimple: () => {
					const call = calls++;
					events.push(`provider-start-${call}`);
					const stream = createAssistantMessageEventStream();
					void releases[call]!.then(() => {
						events.push(`provider-done-${call}`);
						const answer = assistantMessage(`answer-${call}`);
						stream.push({ type: "start", partial: answer });
						stream.push({ type: "done", reason: "stop", message: answer });
						stream.end();
					});
					return stream;
				},
			},
		},
	});
}

async function waitForPath(filePath: string, maxTicks = 100): Promise<void> {
	for (let tick = 0; tick < maxTicks; tick += 1) {
		if (
			await access(filePath).then(
				() => true,
				() => false,
			)
		)
			return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`missing path: ${filePath}`);
}

async function pumpUntil(events: readonly string[], expected: string, maxTicks = 100): Promise<void> {
	for (let tick = 0; tick < maxTicks; tick += 1) {
		if (events.includes(expected)) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`missing lifecycle event: ${expected}`);
}

async function createSession(
	events: string[],
	releases: Array<Promise<void>>,
	extensionFactories: Array<(pi: never) => void> = [],
) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "bebop-follow-up-cwd-"));
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "bebop-follow-up-agent-"));
	const provider = createProvider(events, releases);
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories,
		systemPromptOverride: () => "Follow-up host fixture.",
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		thinkingLevel: "off",
		noTools: "builtin",
		resourceLoader,
		sessionManager,
		settingsManager: settings,
	});
	return {
		cwd,
		session,
		sessionManager,
		settings,
		extensionsResult,
		cleanup: async () => {
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		},
	};
}

test("TASK-0147: loaded extension Broadcast hint reaches joined target Inbox bridge", async (t) => {
	const events: string[] = [];
	let releaseBusy!: () => void;
	const busyRelease = new Promise<void>((resolve) => (releaseBusy = resolve));
	const target = await createSession(events, [busyRelease], [bebopExtension as never]);
	const targetSocket = path.join(target.cwd, ".pi", "bebop", "sockets", "target.sock");
	await mkdir(path.dirname(targetSocket), { recursive: true });
	await writeFile(
		path.join(target.cwd, ".pi", "bebop", "crew.json"),
		JSON.stringify({
			version: 1,
			members: [
				{ name: "Target", role: "qa", socket: "sockets/target.sock" },
				{ name: "Sender", role: "lead", socket: "sockets/sender.sock" },
			],
		}),
	);
	target.settings.setProjectTrusted(true);
	(target.extensionsResult as unknown as { runtime: { flagValues: Map<string, unknown> } }).runtime.flagValues.set(
		"crew",
		true,
	);
	await target.session.bindExtensions({});
	await target.session.prompt("/crew join .pi/bebop/sockets/target.sock");
	await waitForPath(targetSocket);
	t.after(async () => {
		await target.session.prompt("/crew stop").catch(() => undefined);
		await target.cleanup();
	});
	const received: any[] = [];
	target.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "custom") {
			received.push(event.message);
			if (event.message.details?.inbox) events.push("inbox-offer");
		}
	});
	const busyTurn = target.session.prompt("busy target turn");
	await pumpUntil(events, "provider-start-0");
	const liveTargetSocket = await realpath(targetSocket);
	const membership = {
		manifestPath: path.join(target.cwd, ".pi", "bebop", "crew.json"),
		socketPath: path.join(target.cwd, ".pi", "bebop", "sockets", "sender.sock"),
		member: {
			name: "Sender",
			role: "lead",
			socket: "sockets/sender.sock",
			socketPath: path.join(target.cwd, ".pi", "bebop", "sockets", "sender.sock"),
		},
		manifest: {
			version: 1,
			presence: { notifications: true },
			members: [
				{ name: "Target", role: "qa", socket: "sockets/target.sock", socketPath: targetSocket },
				{
					name: "Sender",
					role: "lead",
					socket: "sockets/sender.sock",
					socketPath: path.join(target.cwd, ".pi", "bebop", "sockets", "sender.sock"),
				},
			],
		},
	};
	const senderState = createSocketState();
	senderState.membershipRuntime = { getMembership: () => membership as never } as never;
	const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<any> }> = [];
	registerBroadcastToCrewTool({ registerTool: (tool) => tools.push(tool as never) } as never, senderState, {
		isProjectTrusted: () => true,
		openStore: async (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
		sendHint: (endpoint, command, options) => sendRpcCommand(liveTargetSocket, command, options),
	});
	const broadcastTool = tools.find((tool) => tool.name === "broadcast_to_crew");
	assert.ok(broadcastTool);
	const broadcast = await broadcastTool.execute("broadcast-call", { message: "broadcast lifecycle" });
	assert.equal((broadcast.details as { persisted: number }).persisted, 1, JSON.stringify(broadcast));
	releaseBusy();
	await busyTurn;
	await target.session.waitForIdle();
	await pumpUntil(events, "inbox-offer");
	const offers = received.filter((message) => message.details?.inbox);
	assert.equal(offers.length, 1);
	assert.match(offers[0].details.inbox.itemId, /^broadcast-/);
	assert.equal(offers[0].details.messagePayload.content, "broadcast lifecycle");
	assert.deepEqual(offers[0].details.messagePayload.origin, { kind: "crew", name: "Sender", role: "lead" });
});

test("TASK-0145: baseline and busy Follow-up both preserve host lifecycle ordering", async (t) => {
	const baselineEvents: string[] = [];
	let releaseBaseline!: () => void;
	const baselineRelease = new Promise<void>((resolve) => (releaseBaseline = resolve));
	const baseline = await createSession(baselineEvents, [baselineRelease]);
	t.after(() => baseline.cleanup());
	const baselineRun = baseline.session.prompt("baseline").catch((error) => {
		baselineEvents.push(`prompt-error:${error instanceof Error ? error.message : String(error)}`);
		throw error;
	});
	await pumpUntil(baselineEvents, "provider-start-0");
	releaseBaseline();
	await baselineRun;
	assert.deepEqual(
		baselineEvents.filter((event) => event.startsWith("provider-")),
		["provider-start-0", "provider-done-0"],
	);

	const busyEvents: string[] = [];
	let releaseBusy!: () => void;
	let releaseFollowUp!: () => void;
	const busyRelease = new Promise<void>((resolve) => (releaseBusy = resolve));
	const followUpRelease = new Promise<void>((resolve) => (releaseFollowUp = resolve));
	const busy = await createSession(busyEvents, [busyRelease, followUpRelease]);
	t.after(() => busy.cleanup());
	let busyTurnEnds = 0;
	const handedOff: Array<{ content: unknown; details: unknown }> = [];
	busy.session.subscribe((event) => {
		if (event.type === "turn_end") busyTurnEnds += 1;
		if (event.type === "message_start" && event.message.role === "custom")
			handedOff.push({ content: event.message.content, details: event.message.details });
	});
	const currentTurn = busy.session.prompt("current turn");
	await pumpUntil(busyEvents, "provider-start-0");
	const adapter = createModelDeliveryAdapter((message, options) => {
		void busy.session.sendCustomMessage(message as never, options as never);
	});
	const followUp = {
		customType: "crew-follow-up",
		content: "queued update",
		display: true,
		details: {
			source: "fixture",
			instructions: ["keep FIFO"],
			origin: { kind: "crew", name: "Sender", role: "qa" },
		},
	};
	assert.deepEqual(adapter.send(followUp, { triggerTurn: true, deliverAs: "followUp" }), {
		disposition: "direct",
	});
	assert.deepEqual(
		busyEvents.filter((event) => event.startsWith("provider-")),
		["provider-start-0"],
		"busy Follow-up must not start a competing turn",
	);
	releaseBusy();
	await pumpUntil(busyEvents, "provider-start-1");
	assert.equal(busyTurnEnds, 1, "the current turn settles before the queued Follow-up turn");
	assert.deepEqual(
		busyEvents.filter((event) => event.startsWith("provider-")),
		["provider-start-0", "provider-done-0", "provider-start-1"],
	);
	releaseFollowUp();
	await busy.session.waitForIdle();
	assert.equal(handedOff.length, 1, "queued Follow-up is handed to the next turn exactly once");
	assert.deepEqual(handedOff[0], {
		content: "queued update",
		details: {
			source: "fixture",
			instructions: ["keep FIFO"],
			origin: { kind: "crew", name: "Sender", role: "qa" },
		},
	});
	assert.deepEqual(
		busyEvents.filter((event) => event.startsWith("provider-")),
		["provider-start-0", "provider-done-0", "provider-start-1", "provider-done-1"],
	);
});

test("TASK-0145: real send_follow_up RPC rejects a busy recipient", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bebop-follow-up-rpc-"));
	const targetEvents: string[] = [];
	let releaseCurrent!: () => void;
	let releaseFollowUp!: () => void;
	const currentRelease = new Promise<void>((resolve) => (releaseCurrent = resolve));
	const followUpRelease = new Promise<void>((resolve) => (releaseFollowUp = resolve));
	const target = await createSession(targetEvents, [currentRelease, followUpRelease], [bebopExtension as never]);
	const targetSocket = path.join(target.cwd, ".pi", "bebop", "sockets", "target.sock");
	await mkdir(path.dirname(targetSocket), { recursive: true });
	await writeFile(
		path.join(target.cwd, ".pi", "bebop", "crew.json"),
		JSON.stringify({
			version: 1,
			members: [
				{ name: "Target", role: "qa", socket: "sockets/target.sock" },
				{ name: "Sender", role: "lead", socket: "sockets/sender.sock" },
			],
		}),
	);
	target.settings.setProjectTrusted(true);
	(target.extensionsResult as unknown as { runtime: { flagValues: Map<string, unknown> } }).runtime.flagValues.set(
		"crew",
		true,
	);
	await target.session.bindExtensions({});
	await target.session.prompt("/crew join .pi/bebop/sockets/target.sock");
	t.after(async () => {
		await target.cleanup();
		await rm(root, { recursive: true, force: true });
	});

	let turnEnds = 0;
	const received: unknown[] = [];
	target.session.subscribe((event) => {
		if (event.type === "turn_end") turnEnds += 1;
		if (event.type === "message_start" && event.message.role === "custom") received.push(event.message);
	});
	const currentTurn = target.session.prompt("current turn");
	await pumpUntil(targetEvents, "provider-start-0");

	const senderState = createSocketState();
	senderState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: path.join(target.cwd, ".pi", "bebop", "crew.json"),
			socketPath: path.join(target.cwd, ".pi", "bebop", "sockets", "sender.sock"),
			member: {
				name: "Sender",
				role: "lead",
				socketPath: path.join(target.cwd, ".pi", "bebop", "sockets", "sender.sock"),
			},
			manifest: {
				members: [
					{
						name: "Sender",
						role: "lead",
						socketPath: path.join(target.cwd, ".pi", "bebop", "sockets", "sender.sock"),
					},
					{ name: "Target", role: "qa", socketPath: targetSocket },
				],
			},
		}),
	} as never;
	const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
	registerSendFollowUpTool({ registerTool: (tool) => tools.push(tool as never) } as never, senderState, {
		transport: {
			send: (endpoint, command, options) =>
				sendRpcCommand(endpoint, command, {
					signal: options.signal,
					classifyLostAck: options.classifyLostAck,
				}),
		},
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	});
	const followUpTool = tools.find((tool) => tool.name === "send_follow_up");
	assert.ok(followUpTool);
	const acknowledgement = (await followUpTool.execute("rpc-call", {
		member: "Target",
		message: "queued update",
		instructions: ["keep FIFO"],
	})) as { details: { error: string } };
	assert.equal(acknowledgement.details.error, "target-busy");
	assert.deepEqual(
		targetEvents,
		["provider-start-0"],
		"accepted RPC Follow-up does not compete with the active turn",
	);

	releaseCurrent();
	await target.session.waitForIdle();
	assert.equal(received.length, 0, "rejected Follow-up is never delivered");
	await currentTurn;
	await target.session.prompt("/crew stop");
});
