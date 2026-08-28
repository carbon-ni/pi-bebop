import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
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
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSocketState, handleCommand } from "./control-runtime.ts";
import { parseRenderedMessagePayload, type MessagePayload } from "../domain/index.ts";
import { registerWaitForMemberIdleTool, type MemberIdleWaitToolTransport } from "../tools/wait-for-member-idle.ts";

/**
 * TASK-0089 Pi-host continuation characterization.
 *
 * Proves the message-consumption contract at the REAL Pi agent boundary —
 * not at the `pi.sendMessage` adapter: a deterministic fake provider captures
 * every provider context, the real `wait_for_member_idle` tool is registered
 * through the real extension tool API, and the wake delivery goes through the
 * real `handleCommand` send path, so the queued Follow-up/Redirect enters Pi's
 * real message queue.
 *
 * Contract under proof (message-received wake, `terminate: true`):
 *
 *   provider call N   : assistant calls wait_for_member_idle (busy target)
 *   [tool executes; wake delivery accepted]
 *   provider call N+1 : [..., assistant(toolCall), toolResult(message-received),
 *                        waking message] — the message is consumed before any
 *                       new assistant action; no content-free continuation.
 */

const WAKE_CONTENT_1 = "WAKE-A: consume me exactly once";
const WAKE_CONTENT_2 = "WAKE-B: ordered behind the first";

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "bebop-fake",
		provider: "bebop-fake",
		model: "fake-1",
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

interface FakeHarness {
	readonly session: ReturnType<typeof createAgentSession> extends Promise<infer T> ? T["session"] : never;
	readonly contexts: Context[];
	readonly script: AssistantMessage[];
	readonly state: ReturnType<typeof createSocketState>;
	readonly pi: ExtensionAPI;
	readonly cleanup: () => Promise<void>;
}

/** Parking transport: alive target, idle subscription parks until aborted. */
const parkTransport: MemberIdleWaitToolTransport = {
	probeEndpoint: async () => true,
	requestIdleWait: (_endpoint, _label, options) =>
		new Promise<never>(() => {
			options.signal?.addEventListener("abort", () => undefined, { once: true });
		}),
};

async function createFakeSession(
	options: { readonly extraTool?: (pi: ExtensionAPI) => void } = {},
): Promise<FakeHarness> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-0089-cwd-"));
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-0089-agent-"));
	const contexts: Context[] = [];
	const script: AssistantMessage[] = [];
	const state = createSocketState();

	const streamSimple = (_model: Model<"bebop-fake">, context: Context) => {
		contexts.push(context);
		const stream = createAssistantMessageEventStream();
		const message = script.shift();
		queueMicrotask(() => {
			if (!message) {
				const error = assistantMessage([], "error");
				error.errorMessage = "fake script exhausted";
				stream.push({ type: "error", reason: "error", error });
				stream.end();
				return;
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
		});
		return stream;
	};

	const fakeModel: Model<"bebop-fake"> = {
		id: "fake-1",
		name: "Fake 1",
		api: "bebop-fake",
		provider: "bebop-fake",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
	const provider: Provider<"bebop-fake"> = createProvider({
		id: "bebop-fake",
		name: "Bebop Fake",
		models: [fakeModel],
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
		api: { "bebop-fake": { streamSimple } },
	});

	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/tmp/a.sock",
			member: { name: "Tony", role: "lead", socketPath: "/tmp/a.sock" },
			manifest: {
				members: [
					{ name: "Tony", role: "lead", socketPath: "/tmp/a.sock" },
					{ name: "Kelly", role: "qa", socketPath: "/tmp/b.sock" },
				],
			},
		}),
	} as never;
	state.context = {
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => false,
		sessionManager: { getSessionId: () => "continuation-session" },
	} as never;

	const settings = () => SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let piRef: ExtensionAPI | undefined;
	const inlineExtension = {
		name: "bebop-0089-continuation",
		factory: (pi: ExtensionAPI) => {
			piRef = pi;
			registerWaitForMemberIdleTool(pi, state, parkTransport);
			options.extraTool?.(pi);
		},
	};

	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(provider);

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings(),
		extensionFactories: [inlineExtension as never],
		systemPromptOverride: () => "You are a continuation characterization probe.",
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fakeModel,
		modelRuntime,
		thinkingLevel: "off",
		noTools: "builtin",
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: settings(),
	});

	return {
		session,
		contexts,
		script,
		state,
		get pi(): ExtensionAPI {
			assert.ok(piRef, "extension factory must have run");
			return piRef;
		},
		cleanup: async () => {
			session.dispose();
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(agentDir, { recursive: true, force: true });
		},
	};
}

/** Bounded wait until the local blocking idle wait is armed (wake-gate arm is synchronous inside execute). */
async function waitForArmedWake(state: ReturnType<typeof createSocketState>, deadlineMs = 5_000): Promise<void> {
	const started = Date.now();
	while (!state.wakeGate.armed) {
		if (Date.now() - started > deadlineMs) throw new Error("wake gate was never armed");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function deliver(
	pi: ExtensionAPI,
	state: ReturnType<typeof createSocketState>,
	id: string,
	payload: MessagePayload,
	delivery: "follow_up" | "steer",
): Promise<void> {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	await handleCommand(pi, state, { type: "send", id, payload, delivery } as never, socket);
	assert.match(writes.at(-1) ?? "", /"deliveryId":/, "wake delivery must be accepted");
}

const plainPayload = (content: string): MessagePayload => ({ content });

const fullPayload = (content: string): MessagePayload => ({
	content,
	instructions: ["instruction-one", "instruction-two"],
	origin: { kind: "crew", name: "Mary", role: "lead" },
	replyTo: { sessionId: "callback-session-0089", sessionName: "Callback Route" },
});

function textBlocks(context: Context): Array<{ role: string; text: string }> {
	const rendered: Array<{ role: string; text: string }> = [];
	for (const message of context.messages as Array<Record<string, unknown>>) {
		const role = String(message.role ?? message.type ?? "unknown");
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; text?: string }>) {
			if (block.type === "text" && typeof block.text === "string") rendered.push({ role, text: block.text });
		}
	}
	return rendered;
}

function occurrences(context: Context, needle: string): number {
	return textBlocks(context).filter(({ text }) => text.includes(needle)).length;
}

test("TASK-0089: accepted Follow-up is consumed in the next provider context before any assistant action", async (t) => {
	const harness = await createFakeSession();
	t.after(() => harness.cleanup());

	harness.script.push(
		assistantMessage(
			[{ type: "toolCall", id: "tc1", name: "wait_for_member_idle", arguments: { member: "Kelly" } }],
			"toolUse",
		),
		assistantMessage([{ type: "text", text: "acknowledged" }], "stop"),
	);

	const promptDone = harness.session.prompt("wait for kelly");
	await waitForArmedWake(harness.state);
	await deliver(harness.pi, harness.state, "w1", fullPayload(WAKE_CONTENT_1), "follow_up");
	await promptDone;

	// Exactly two provider calls: the tool-call turn and the post-message turn.
	// A third, content-free tool-result continuation would break this contract.
	assert.equal(harness.contexts.length, 2, `expected 2 provider calls, got ${harness.contexts.length}`);
	const second = harness.contexts[1]!;
	const blocks = textBlocks(second);

	// The waking message is present exactly once, rendered with its follow-up mode.
	assert.equal(occurrences(second, WAKE_CONTENT_1), 1);
	const wakeBlock = blocks.find(({ text }) => text.includes(WAKE_CONTENT_1));
	assert.ok(wakeBlock);
	assert.ok(wakeBlock.text.includes("follow-up"));
	const renderedPayload = wakeBlock.text.slice(wakeBlock.text.indexOf("\n") + 1);
	assert.deepEqual(parseRenderedMessagePayload(renderedPayload), fullPayload(WAKE_CONTENT_1));
	for (const field of [
		"instruction-one",
		"instruction-two",
		'"name":"Mary"',
		'"role":"lead"',
		'"sessionId":"callback-session-0089"',
		'"sessionName":"Callback Route"',
	]) {
		assert.equal(wakeBlock.text.split(field).length - 1, 1, `${field} must cross the provider boundary once`);
	}

	// Order: toolResult(message-received) then the waking message, with no
	// assistant action between them — the message is the next consumed input.
	const toolResultIndex = blocks.findIndex(
		({ role, text }) => role === "toolResult" && text.includes("message-received"),
	);
	const wakeIndex = blocks.findIndex(({ text }) => text.includes(WAKE_CONTENT_1));
	assert.ok(toolResultIndex >= 0, "message-received tool result must be persisted in context");
	assert.ok(wakeIndex > toolResultIndex, "waking message must follow the tool result");
	const between = blocks.slice(toolResultIndex + 1, wakeIndex);
	assert.deepEqual(
		between.filter(({ role }) => role === "assistant"),
		[],
		"no assistant action may precede the consumed waking message",
	);

	// The turn completed normally after consuming the message: the run's final
	// assistant message is the response to the consumed waking message.
	const finalMessages = harness.session.agent.state.messages as Array<{
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
	assert.ok(
		finalMessages.some(
			(message) =>
				message.role === "assistant" && message.content?.some((block) => block.text?.includes("acknowledged")),
		),
	);
});

test("TASK-0089: accepted Redirect keeps steer semantics and is consumed at its turn boundary", async (t) => {
	const harness = await createFakeSession();
	t.after(() => harness.cleanup());

	harness.script.push(
		assistantMessage(
			[{ type: "toolCall", id: "tc1", name: "wait_for_member_idle", arguments: { member: "Kelly" } }],
			"toolUse",
		),
		assistantMessage([{ type: "text", text: "steered" }], "stop"),
	);

	const promptDone = harness.session.prompt("wait for kelly");
	await waitForArmedWake(harness.state);
	await deliver(harness.pi, harness.state, "w2", plainPayload(WAKE_CONTENT_1), "steer");
	await promptDone;

	assert.equal(harness.contexts.length, 2, "redirect wake must not create a content-free continuation");
	const second = harness.contexts[1]!;
	assert.equal(occurrences(second, WAKE_CONTENT_1), 1);
	const blocks = textBlocks(second);
	const wakeIndex = blocks.findIndex(({ text }) => text.includes(WAKE_CONTENT_1));
	assert.ok(wakeIndex >= 0, "redirect must be consumed in the next provider context");
	const finalMessages = harness.session.agent.state.messages as Array<{
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
	assert.ok(
		finalMessages.some(
			(message) =>
				message.role === "assistant" && message.content?.some((block) => block.text?.includes("steered")),
		),
	);
});

test("TASK-0089: a second accepted message stays FIFO-ordered and is never dropped by termination", async (t) => {
	const harness = await createFakeSession();
	t.after(() => harness.cleanup());

	harness.script.push(
		assistantMessage(
			[{ type: "toolCall", id: "tc1", name: "wait_for_member_idle", arguments: { member: "Kelly" } }],
			"toolUse",
		),
		assistantMessage([{ type: "text", text: "first consumed" }], "stop"),
		assistantMessage([{ type: "text", text: "second consumed" }], "stop"),
	);

	const promptDone = harness.session.prompt("wait for kelly");
	await waitForArmedWake(harness.state);
	await deliver(harness.pi, harness.state, "w3", plainPayload(WAKE_CONTENT_1), "follow_up");
	await deliver(harness.pi, harness.state, "w4", plainPayload(WAKE_CONTENT_2), "follow_up");
	await promptDone;

	// Pi drains one queued Follow-up per turn: the terminating tool result
	// skips the content-free continuation, msg1 drives turn 2, msg2 drives
	// turn 3. Both survive termination cleanup, delivered once each, in FIFO
	// order (history persistence keeps earlier deliveries visible in later
	// contexts; delivery is the property under proof).
	assert.equal(harness.contexts.length, 3);
	const second = harness.contexts[1]!;
	const third = harness.contexts[2]!;
	assert.equal(occurrences(second, WAKE_CONTENT_1), 1, "first message is delivered in turn 2");
	assert.equal(occurrences(second, WAKE_CONTENT_2), 0, "second message is not delivered early");
	assert.equal(occurrences(third, WAKE_CONTENT_2), 1, "second message is delivered in turn 3, not dropped");
	const blocks = textBlocks(third);
	assert.ok(
		blocks.some(({ text }) => text.includes("first consumed")),
		"turn 3 context contains turn 2's reply history",
	);
	const finalMessages = harness.session.agent.state.messages as Array<{
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
	assert.ok(
		finalMessages.some(
			(message) =>
				message.role === "assistant" &&
				message.content?.some((block) => block.text?.includes("second consumed")),
		),
	);
});

test("TASK-0089: mixed batch — non-terminating sibling tool call (characterized Pi scheduling rule)", async (t) => {
	const harness = await createFakeSession({
		extraTool: (pi) => {
			pi.registerTool({
				name: "bebop_noop",
				label: "Noop",
				description: "Deterministic non-terminating sibling tool",
				parameters: { type: "object", properties: {}, additionalProperties: false } as never,
				execute: async () => ({
					content: [{ type: "text", text: "noop done" }],
					details: {},
				}),
			} as never);
		},
	});
	t.after(() => harness.cleanup());

	harness.script.push(
		assistantMessage(
			[
				{ type: "toolCall", id: "tc1", name: "wait_for_member_idle", arguments: { member: "Kelly" } },
				{ type: "toolCall", id: "tc2", name: "bebop_noop", arguments: {} },
			],
			"toolUse",
		),
		assistantMessage([{ type: "text", text: "mixed consumed" }], "stop"),
	);

	const promptDone = harness.session.prompt("wait with a sibling");
	await waitForArmedWake(harness.state);
	await deliver(harness.pi, harness.state, "w5", plainPayload(WAKE_CONTENT_1), "follow_up");
	await promptDone;
	const second = harness.contexts[1]!;
	const wakeCount = occurrences(second, WAKE_CONTENT_1);
	// CHARACTERIZED UPSTREAM RULE (Pi 0.84.x): termination skips the
	// tool-result continuation only when EVERY result in the batch
	// terminates. A non-terminating sibling (bebop_noop) forces the ordinary
	// content-free continuation first (context 2 = tool results only), and
	// the waking message is consumed exactly once in the following context.
	// This is why the public tool guidance mandates a solitary/sequential
	// call; recorded as an upstream Pi API constraint in the TASK-0089 plan.
	assert.equal(harness.contexts.length, 3, "mixed batch must produce exactly one content-free continuation");
	assert.equal(wakeCount, 0, "context 2 must not contain the waking message (all-results-terminate rule)");
	const third = harness.contexts[2]!;
	assert.equal(occurrences(third, WAKE_CONTENT_1), 1, "waking message consumed exactly once later, never dropped");
	const blocks = textBlocks(second);
	assert.ok(blocks.some(({ role, text }) => role === "toolResult" && text.includes("message-received")));
	assert.ok(blocks.some(({ role, text }) => role === "toolResult" && text.includes("noop done")));
});
