import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAssistantMessageEventStream,
	createProvider as createAiProvider,
	type AssistantMessage,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
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

async function pumpUntil(events: readonly string[], expected: string, maxTicks = 100): Promise<void> {
	for (let tick = 0; tick < maxTicks; tick += 1) {
		if (events.includes(expected)) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`missing lifecycle event: ${expected}`);
}

async function createSession(events: string[], releases: Array<Promise<void>>) {
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
		extensionFactories: [],
		systemPromptOverride: () => "Follow-up host fixture.",
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
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
		session,
		cleanup: async () => {
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		},
	};
}

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
