import { promises as fs } from "node:fs";
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
import { createModelDeliveryAdapter } from "../src/pi/compaction-delivery.ts";
import { openTrustedCompactionDeliveryJournal } from "../src/infra/compaction-delivery-journal.ts";

const mode = process.argv[2];
const root = process.env.COMPACTION_PI_CRASH_ROOT;
if (!mode || !root) throw new Error("mode and COMPACTION_PI_CRASH_ROOT are required");

const cwd = path.join(root, "cwd");
const agentDir = path.join(root, "agent");
const sessionDir = path.join(root, "sessions");
const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(manifestPath, "{}\n");
const journal = await openTrustedCompactionDeliveryJournal({
	manifestPath,
	projectRoot: root,
	isProjectTrusted: () => true,
	memberName: "Dave",
});

const model: Model<"bebop-pi-crash"> = {
	id: "pi-crash-1",
	name: "Pi Crash",
	api: "bebop-pi-crash",
	provider: "bebop-pi-crash",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 4_096,
};
const assistantMessage = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "bebop-pi-crash",
	provider: "bebop-pi-crash",
	model: "pi-crash-1",
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
});
const provider = (): Provider<"bebop-pi-crash"> =>
	createProvider({
		id: "bebop-pi-crash",
		name: "Bebop Pi Crash",
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
			"bebop-pi-crash": {
				streamSimple: () => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
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

let piSend: ((message: unknown, options: Readonly<Record<string, unknown>>) => void) | undefined;
const adapter = createModelDeliveryAdapter((message, options) => {
	console.log(`pi-send:${JSON.stringify(message)}`);
	piSend?.(message, options ?? {});
	if (mode === "crash-after-pi" || mode === "recover-replay-crash") process.kill(process.pid, "SIGKILL");
});
const sessionPathFile = path.join(root, "session-path");
let sessionManager: SessionManager;
if (mode === "recover-replay-crash" || mode === "recover-blocked") {
	const sessionPath = await fs.readFile(sessionPathFile, "utf8");
	sessionManager = SessionManager.open(sessionPath.trim(), sessionDir, cwd);
} else {
	sessionManager = SessionManager.create(cwd, sessionDir);
	await fs.mkdir(sessionDir, { recursive: true });
	await fs.writeFile(sessionPathFile, sessionManager.getSessionFile() ?? "");
	for (let index = 0; index < 200; index += 1) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message ".repeat(30) }],
			timestamp: Date.now(),
		} as never);
		sessionManager.appendMessage(assistantMessage("answer ".repeat(30)));
	}
}
const hasEvidence = async (id: string): Promise<boolean> =>
	(sessionManager.getEntries() as readonly unknown[]).some((entry) => JSON.stringify(entry).includes(id));
const settings = SettingsManager.inMemory({
	compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
	retry: { enabled: false },
});
const modelRuntime = await ModelRuntime.create({
	authPath: path.join(agentDir, "auth.json"),
	modelsStorePath: path.join(agentDir, "models-store.json"),
	refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(provider());
const extension = {
	name: "bebop-pi-crash-probe",
	factory: (pi: ExtensionAPI) => {
		piSend = (message, options) => pi.sendMessage(message, options);
		if (mode !== "recover-blocked" && mode !== "recover-replay-crash") {
			pi.on("session_before_compact", async () => {
				const generation = adapter.compactionStarted();
				await adapter.sendDurably({ customType: "crew", content: "Pi crash probe" }, { triggerTurn: true });
				console.log("append-ack");
				if (mode === "crash-after-append") process.kill(process.pid, "SIGKILL");
				currentGeneration = generation;
			});
			pi.on("session_compact", () => adapter.compactionEnded(currentGeneration));
			pi.on("session_compact_failed", () => adapter.compactionEnded(currentGeneration));
		}
	},
};
let currentGeneration = 0;
const loader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager: settings,
	extensionFactories: [extension],
	systemPromptOverride: () => "Pi crash probe.",
});
await loader.reload();
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
await adapter.configureJournal(journal, hasEvidence);
if (mode === "recover-blocked" || mode === "recover-replay-crash") {
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	console.log(
		`records:${JSON.stringify((await journal.listPending()).map((record) => ({ id: record.id, state: record.state, replayAttempts: record.replayAttempts })))}`,
	);
	await session.dispose();
	process.exit(0);
}
await session.compact();
await new Promise<void>((resolve) => setTimeout(resolve, 250));
console.log(
	`records:${JSON.stringify((await journal.listPending()).map((record) => ({ id: record.id, state: record.state, replayAttempts: record.replayAttempts })))}`,
);
await session.dispose();
