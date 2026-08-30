import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAssistantMessageEventStream,
	createProvider,
	type AssistantMessage,
	type Context,
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
import { parseCrewManifest } from "../domain/index.ts";
import { openTrustedCrewBoardStore } from "../infra/crew-board-store.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import { createSocketState } from "./control-runtime.ts";
import { registerLeaveCrewPostTool, registerReadCrewBoardTool } from "../tools/crew-board.ts";

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "bebop-board-host-fake",
		provider: "bebop-board-host-fake",
		model: "board-host-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function textBlocks(context: Context): string[] {
	return (context.messages as Array<{ content?: unknown }>)
		.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string";
		})
		.map((block) => block.text);
}

test("TASK-0142: real extension host appends and reads a canonical Crew Post", async (t) => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-board-host-cwd-"));
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-board-host-agent-"));
	t.after(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	const manifestPath = path.join(cwd, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	const manifest = parseCrewManifest(
		{ version: 1, members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }] },
		manifestPath,
	);
	await fs.writeFile(
		manifestPath,
		JSON.stringify({ version: 1, members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }] }),
	);
	const current: Membership = {
		manifestPath,
		socketPath: manifest.members[0]!.socketPath,
		globalSocketPath: path.join(cwd, "global.sock"),
		member: manifest.members[0]!,
		manifest,
	};
	const state = createSocketState();
	state.membershipRuntime = { getMembership: () => current } as never;
	state.context = {
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => "board-host-session" },
	} as never;

	const contexts: Context[] = [];
	const script: AssistantMessage[] = [
		assistantMessage([{ type: "toolCall", id: "call_Mary|fc_host", name: "leave_crew_post", arguments: { message: "host post" } }], "toolUse"),
		assistantMessage([{ type: "text", text: "append complete" }], "stop"),
		assistantMessage([{ type: "toolCall", id: "call_read|fc_host", name: "read_crew_board", arguments: {} }], "toolUse"),
		assistantMessage([{ type: "text", text: "read complete" }], "stop"),
	];
	const model: Model<"bebop-board-host-fake"> = {
		id: "board-host-1",
		name: "Board Host 1",
		api: "bebop-board-host-fake",
		provider: "bebop-board-host-fake",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
	const provider: Provider<"bebop-board-host-fake"> = createProvider({
		id: "bebop-board-host-fake",
		name: "Bebop Board Host Fake",
		models: [model],
		auth: {
			apiKey: {
				name: "test key",
				async login() {
					return { type: "api_key", key: "test" };
				},
				async resolve() {
					return { auth: { apiKey: "test" }, source: "TASK-0142 host test" };
				},
			},
		},
		api: {
			"bebop-board-host-fake": {
				streamSimple: (_model: Model<"bebop-board-host-fake">, context: Context) => {
					contexts.push(context);
					const stream = createAssistantMessageEventStream();
					const message = script.shift();
					queueMicrotask(() => {
						if (!message) {
							const error = assistantMessage([], "error");
							error.errorMessage = "host script exhausted";
							stream.push({ type: "error", reason: "error", error });
						} else {
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: message.stopReason, message });
						}
						stream.end();
					});
					return stream;
				},
			},
		},
	});

	const inlineExtension = {
		name: "bebop-board-host",
		factory: (pi: ExtensionAPI) => {
			const dependencies = {
				isProjectTrusted: () => true,
				getCurrentMembership: () => current,
				openStore: openTrustedCrewBoardStore,
			};
			registerLeaveCrewPostTool(pi, state, dependencies);
			registerReadCrewBoardTool(pi, state, dependencies);
		},
	};
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
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
		extensionFactories: [inlineExtension],
		systemPromptOverride: () => "Use the registered Crew Board tools.",
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		thinkingLevel: "off",
		noTools: "builtin",
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: settings,
	});
	t.after(() => session.dispose());

	await session.prompt("append one post");
	await session.prompt("read the board");
	const allText = contexts.flatMap(textBlocks).join("\n");
	assert.match(allText, /Crew Post persisted \(post-[a-f0-9]{64}, sequence 1\)/);
	assert.match(allText, /host post/);
	const persisted = await (
		await openTrustedCrewBoardStore({
			projectRoot: cwd,
			manifestPath,
			isProjectTrusted: () => true,
			member: { name: "Mary", role: "po", socketPath: current.socketPath },
		})
	).read();
	assert.equal(persisted.posts.length, 1);
});
