import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAssistantMessageEventStream,
	createProvider,
	type AssistantMessage,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createModelDeliveryAdapter } from "./compaction-delivery.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "bebop-host-fake",
		provider: "bebop-host-fake",
		model: "host-fake-1",
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

const model: Model<"bebop-host-fake"> = {
	id: "host-fake-1",
	name: "Host Fake",
	api: "bebop-host-fake",
	provider: "bebop-host-fake",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 4_096,
};

function createProviderFor(events: string[]): Provider<"bebop-host-fake"> {
	return createProvider({
		id: "bebop-host-fake",
		name: "Bebop Host Fake",
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
			"bebop-host-fake": {
				streamSimple: () => {
					events.push("provider-start");
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						events.push("provider-done");
						const summary = assistantMessage("compaction summary");
						stream.push({ type: "start", partial: summary });
						stream.push({ type: "done", reason: "stop", message: summary });
						stream.end();
					});
					return stream;
				},
			},
		},
	});
}

test("Pi 0.84.3 host drains deferred delivery after provider compaction terminal", async (t) => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "bebop-compaction-host-cwd-"));
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "bebop-compaction-host-agent-"));
	t.after(async () => {
		await rm(cwd, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});

	const events: string[] = [];
	const adapter = createModelDeliveryAdapter(() => events.push("send"));
	const journal = {
		filePath: path.join(agentDir, "delivery.json"),
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: Date.now(),
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	await adapter.configureJournal(journal);

	let generation = 0;
	const extension = {
		name: "bebop-compaction-host-probe",
		factory: (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event) => {
				events.push(`before:${event.reason}`);
				generation = adapter.compactionStarted();
				await adapter.sendDurably({ customType: "probe", content: "deferred" }, { triggerTurn: true });
				events.push("accepted");
			});
			pi.on("session_compact", () => {
				adapter.compactionEnded(generation);
				events.push("terminal");
			});
		},
	};
	const provider = createProviderFor(events);
	const settings = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
		retry: { enabled: false },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(provider);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [extension],
		systemPromptOverride: () => "Compaction host probe.",
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	for (let index = 0; index < 200; index += 1) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message ".repeat(30) }],
			timestamp: Date.now(),
		} as never);
		sessionManager.appendMessage(assistantMessage("answer ".repeat(30)));
	}
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		thinkingLevel: "off",
		noTools: "all",
		resourceLoader: loader,
		sessionManager,
		settingsManager: settings,
	});
	t.after(() => session.dispose());

	await session.compact();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(events, ["before:manual", "accepted", "provider-start", "provider-done", "terminal", "send"]);
});
