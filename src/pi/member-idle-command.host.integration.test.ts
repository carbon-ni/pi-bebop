import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
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

const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-member-idle-host-home-"));
const previousHome = process.env.HOME;
process.env.HOME = sandboxHome;
const { default: extension } = await import("../extension.ts");

test.after(async () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	await fs.rm(sandboxHome, { recursive: true, force: true });
});

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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

async function listen(
	pathname: string,
	handler: (request: { id: string | number; method: string }, socket: net.Socket) => void,
	connections: Set<net.Socket>,
) {
	const server = net.createServer((socket) => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				const request = JSON.parse(line) as { id: string | number; method: string };
				handler(request, socket);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(pathname, resolve));
	return server;
}

function response(socket: net.Socket, id: string | number, result: unknown): void {
	socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("host boundary timed out")), timeoutMs)),
	]);
}

test("TASK-0121: SDK AgentSession runs actual Crew member-idle asynchronously without provider turn", async (t) => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-member-idle-host-cwd-"));
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-member-idle-host-agent-"));
	const crewDir = path.join(cwd, ".pi", "bebop");
	const socketsDir = path.join(crewDir, "sockets");
	await fs.mkdir(socketsDir, { recursive: true });
	const targetSocket = path.join(socketsDir, "qa.sock");
	const currentSocket = path.join(socketsDir, "dev.sock");
	await fs.writeFile(
		path.join(crewDir, "crew.json"),
		JSON.stringify({
			version: 1,
			members: [
				{ name: "Dev", role: "developer", socket: "sockets/dev.sock" },
				{ name: "QA", role: "qa", socket: "sockets/qa.sock" },
			],
			presence: { notifications: false },
		}),
	);
	let idleWaitSeen!: () => void;
	const idleWait = new Promise<void>((resolve) => {
		idleWaitSeen = resolve;
	});
	const targetConnections = new Set<net.Socket>();
	const target = await listen(
		targetSocket,
		(request, socket) => {
			if (request.method === "member.status") {
				response(socket, request.id, {
					status: {
						member: { name: "QA", role: "qa" },
						presence: "online",
						activity: "busy",
						hasPendingMessages: false,
						observedAt: "2026-08-29T10:00:00.000Z",
					},
				});
				return;
			}
			if (request.method === "member.wait_state") {
				response(socket, request.id, {
					subscriptionId: String(request.id),
					snapshot: { member: { name: "QA", role: "qa" }, wait: null },
				});
				return;
			}
			if (request.method === "member.idle_wait") {
				response(socket, request.id, { subscriptionId: String(request.id), event: "member_idle" });
				idleWaitSeen();
			}
		},
		targetConnections,
	);
	t.after(async () => {
		for (const socket of targetConnections) socket.destroy();
		await new Promise<void>((resolve) => target.close(() => resolve()));
		await fs.rm(cwd, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	const contexts: Context[] = [];
	let probeSignal: AbortSignal | undefined;
	const fakeModel: Model<"bebop-host-fake"> = {
		id: "host-fake-1",
		name: "Host Fake 1",
		api: "bebop-host-fake",
		provider: "bebop-host-fake",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
	const provider: Provider<"bebop-host-fake"> = createProvider({
		id: "bebop-host-fake",
		name: "Bebop Host Fake",
		models: [fakeModel],
		auth: {
			apiKey: {
				name: "test key",
				async login() {
					return { type: "api_key", key: "test" };
				},
				async resolve() {
					return { auth: { apiKey: "test" }, source: "host integration test" };
				},
			},
		},
		api: {
			"bebop-host-fake": {
				streamSimple: (_model: Model<"bebop-host-fake">, context: Context) => {
					contexts.push(context);
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message = assistantMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
						stream.end();
					});
					return stream;
				},
			},
		},
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(provider);
	const probeExtension = {
		name: "member-idle-host-probe",
		factory: (pi: ExtensionAPI) => {
			pi.registerCommand("member-idle-host-probe", {
				description: "Capture the SDK command context signal.",
				handler: async (_args, ctx) => {
					probeSignal = ctx.signal;
				},
			});
		},
	};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [path.resolve("src/extension.ts")],
		extensionFactories: [probeExtension],
		settingsManager,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		model: fakeModel,
		modelRuntime,
		noTools: "all",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	t.after(() => session.dispose());

	await session.prompt(`/crew join ${currentSocket}`);
	await session.prompt("/member-idle-host-probe");
	assert.equal(probeSignal, undefined, "SDK slash command context has no command AbortSignal");
	assert.equal(contexts.length, 0, "join and probe commands must not call the provider");

	const memberIdle = session.prompt("/crew member-idle QA");
	await waitFor(idleWait);
	assert.equal(contexts.length, 0, "actual member-idle command must wait without a provider turn");

	await session.prompt("ordinary prompt while member-idle is pending");
	assert.equal(contexts.length, 1, "ordinary prompt creates exactly one provider turn");
	await waitFor(memberIdle);
	assert.equal(contexts.length, 1, "member-idle adds no provider turn");
	await session.prompt("/crew stop");
	assert.equal(contexts.length, 1, "lifecycle cleanup must not call the provider");
});
